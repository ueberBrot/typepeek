import nodePath from "node:path";

import type { Declaration, Node, SourceFile } from "tsrs/ast";
import {
  SyntaxKind,
  isModuleDeclaration,
  isStringLiteralLikeNode,
  isTypeAliasDeclaration,
} from "tsrs/ast";
import type { FileSystemCallbacks } from "tsrs/fs";
import { API, NodeBuilderFlags, SignatureKind, isRemoteNode } from "tsrs/sync";
import type {
  Checker,
  Program,
  Signature,
  Symbol as CompilerSymbol,
} from "tsrs/sync";

import {
  COMPILER_EXECUTABLE,
  COMPILER_INTRINSIC_FILE,
} from "#typepeek/inspection/compiler/compiler-distribution";
import { symbolsAtLocations } from "#typepeek/inspection/compiler/compiler-queries";
import { bitwiseOr } from "#typepeek/shared/integer-bits";

export interface ResolutionFileSystem {
  readonly directoryExists: (path: string) => boolean;
  readonly fileExists: (path: string) => boolean;
  readonly readFile: (path: string) => string | undefined;
  readonly realpath: (path: string) => string;
  readonly getDirectories: (path: string) => string[];
}

const sessions = new Set<API>();
const checkerSessions = new WeakMap<Checker, { readonly api: API }>();
const checkerPrograms = new WeakMap<Checker, Program>();
const ambientModuleCache = new WeakMap<Checker, readonly CompilerSymbol[]>();
const declarationCache = new WeakMap<CompilerSymbol, readonly Declaration[]>();

/** Native generated trees can retain positive positions but have no program file. */
export const isSourceBackedNode = (node: Node): boolean =>
  isRemoteNode(node) &&
  node.pos >= 0 &&
  nodePath.isAbsolute(node.getSourceFile().fileName);

/** Associates checker handles with an API whose caller owns disposal. */
export const bindCompilerProgram = (program: Program, api: API): Program => {
  checkerSessions.set(program.getProject().checker, { api });
  checkerPrograms.set(program.getProject().checker, program);

  return program;
};

export const retainCompilerProgram = (program: Program, api: API): Program => {
  sessions.add(api);

  return bindCompilerProgram(program, api);
};

/** Owns one native API process and its remote resources for an inspection. */
export class CompilerSession {
  readonly api: API;
  private fileSystem: ResolutionFileSystem | undefined;
  private callbackError: { readonly error: unknown } | null = null;
  private closed = false;

  constructor(cwd = process.cwd()) {
    const guarded = <Value>(read: () => Value, fallback: Value): Value => {
      try {
        return read();
      } catch (error) {
        this.callbackError ??= { error };

        return fallback;
      }
    };

    const fs: FileSystemCallbacks = {
      directoryExists: (path) =>
        guarded(() => this.fileSystem?.directoryExists(path) ?? false, false),
      fileExists: (path) =>
        guarded(() => this.fileSystem?.fileExists(path) ?? false, false),
      getAccessibleEntries: (path) =>
        guarded(
          () => ({
            directories:
              this.fileSystem
                ?.getDirectories(path)
                .map(
                  (directory) => directory.split(/[\\/]/u).at(-1) ?? directory
                ) ?? [],
            files: [],
            symlinks: [],
          }),
          { directories: [], files: [], symlinks: [] }
        ),
      readFile: (path) =>
        guarded(() => this.fileSystem?.readFile(path), undefined),
      realpath: (path) =>
        guarded(() => this.fileSystem?.realpath(path) ?? path, path),
      removeFile: () => {
        throw new Error("Inspection cannot remove compiler files.");
      },
      stat: (path) =>
        guarded(() => {
          let mode: number | undefined;

          if (this.fileSystem?.fileExists(path) === true) {
            mode = 0o10_0444;
          } else if (this.fileSystem?.directoryExists(path) === true) {
            mode = 0o04_0555;
          }

          return mode === undefined
            ? undefined
            : { mode, mtime: new Date(0), size: 0 };
        }, undefined),
      writeFile: () => {
        throw new Error("Inspection cannot emit compiler output.");
      },
    };

    const fast = process.env["TSRS_FAST"];
    const timing = process.env["TS_API_TIMING_DIR"];
    delete process.env["TSRS_FAST"];
    delete process.env["TS_API_TIMING_DIR"];

    try {
      this.api = new API({
        cwd,
        fs,
        maxResponseBytesPerPage: 16 * 1024 * 1024,
        runExternalCode: false,
        tsserverPath: COMPILER_EXECUTABLE,
      });
    } finally {
      if (fast !== undefined) {
        process.env["TSRS_FAST"] = fast;
      }

      if (timing !== undefined) {
        process.env["TS_API_TIMING_DIR"] = timing;
      }
    }

    sessions.add(this.api);
  }

  withFileSystem<Value>(
    fileSystem: ResolutionFileSystem,
    run: () => Value
  ): Value {
    const previous = this.fileSystem;
    this.fileSystem = fileSystem;

    try {
      const result = run();

      if (this.callbackError !== null) {
        throw this.callbackError.error;
      }

      return result;
    } finally {
      this.fileSystem = previous;
      this.callbackError = null;
    }
  }

  retainProgram(program: Program): Program {
    return retainCompilerProgram(program, this.api);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    sessions.delete(this.api);
    this.api.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export const closeCompilerSessions = (): void => {
  for (const api of sessions) {
    api.close();
  }

  sessions.clear();
};

const compilerSessionFor = (checker: Checker): { readonly api: API } => {
  const session = checkerSessions.get(checker);

  if (session === undefined) {
    throw new Error("The compiler checker has no active native session.");
  }

  return session;
};

export const declarationsOf = (
  symbol: CompilerSymbol | undefined
): readonly Declaration[] => {
  if (symbol === undefined) {
    return [];
  }

  let declarations = declarationCache.get(symbol);

  if (declarations === undefined) {
    declarations = symbol.declarations.flatMap((handle) => {
      const declaration = handle.resolve();

      return declaration === undefined ? [] : [declaration];
    });
    declarationCache.set(symbol, declarations);
  }

  return declarations;
};

export const valueDeclarationOf = (
  symbol: CompilerSymbol
): Declaration | undefined => symbol.valueDeclaration?.resolve();

export const printCompilerNode = (checker: Checker, node: Node): string =>
  compilerSessionFor(checker).api.printer.printNode(node);

/** These independent metadata queries share one native round trip. */
export const signatureParts = (checker: Checker, signature: Signature) => {
  const [parameters, typeParameters, thisParameter] = compilerSessionFor(
    checker
  ).api.batch(
    signature.getParameters.gen(),
    signature.getTypeParameters.gen(),
    signature.getThisParameter.gen()
  );

  return { parameters, thisParameter, typeParameters: typeParameters ?? [] };
};

export const signatureText = (
  checker: Checker,
  signature: Signature,
  location?: Node,
  kind = SignatureKind.Call
): string => {
  const node = checker.signatureToSignatureDeclaration(
    signature,
    kind === SignatureKind.Construct
      ? SyntaxKind.ConstructSignature
      : SyntaxKind.CallSignature,
    location,
    bitwiseOr(
      bitwiseOr(
        NodeBuilderFlags.NoTruncation,
        NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope
      ),
      bitwiseOr(
        NodeBuilderFlags.NoTypeReduction,
        NodeBuilderFlags.UseSingleQuotesForStringLiteralType
      )
    )
  );

  if (node === undefined) {
    throw new Error("The native compiler could not project a signature.");
  }

  return printCompilerNode(checker, node).trim().replace(/;$/u, "");
};

const sourceFilesOf = (program: Program): readonly SourceFile[] =>
  program.getSourceFileNames().flatMap((file) => {
    const source = program.getSourceFile(file);

    return source === undefined ? [] : [source];
  });

export const ambientModules = (checker: Checker): readonly CompilerSymbol[] => {
  const cached = ambientModuleCache.get(checker);

  if (cached !== undefined) {
    return cached;
  }

  const program = checkerPrograms.get(checker);

  if (program === undefined) {
    throw new Error("Ambient modules need an active program.");
  }

  const declarations = sourceFilesOf(program).flatMap((file) =>
    file.statements.filter(
      (statement) =>
        isModuleDeclaration(statement) &&
        isStringLiteralLikeNode(statement.name)
    )
  );

  const symbols = symbolsAtLocations(
    checker,
    declarations.map((declaration) =>
      isModuleDeclaration(declaration) ? declaration.name : declaration
    )
  );

  const result = [
    ...new Set(
      symbols.flatMap((symbol) => (symbol === undefined ? [] : [symbol]))
    ),
  ];

  ambientModuleCache.set(checker, result);

  return result;
};

export const emptyArgumentsType = (checker: Checker) => {
  const source = checkerPrograms
    .get(checker)
    ?.getSourceFile(COMPILER_INTRINSIC_FILE);

  const declaration = source?.statements[0];

  if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
    throw new Error("The native program is missing its intrinsic tuple.");
  }

  return checker.getTypeFromTypeNode(declaration.type);
};
