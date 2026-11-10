import { Effect, Semaphore } from "effect";
import type { Declaration, Node, SourceFile } from "tsrs/ast";
import {
  SyntaxKind,
  isModuleDeclaration,
  isStringLiteralLikeNode,
  isTypeAliasDeclaration,
} from "tsrs/ast";
import { API, NodeBuilderFlags, SignatureKind, isRemoteNode } from "tsrs/async";
import type {
  Checker,
  Program,
  Signature,
  Symbol as CompilerSymbol,
} from "tsrs/async";
import type { FileSystemCallbacks } from "tsrs/fs";

import {
  COMPILER_EXECUTABLE,
  COMPILER_INTRINSIC_FILE,
} from "#typepeek/inspection/compiler/compiler-distribution";
import { symbolsAtLocations } from "#typepeek/inspection/compiler/compiler-queries";
import { createCompilerSessionOwner } from "#typepeek/inspection/compiler/compiler-session-owner";
import type { CompilerSessionOwner } from "#typepeek/inspection/compiler/compiler-session-owner";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { mapAsync } from "#typepeek/shared/async-collection";
import { runAdapterEffect } from "#typepeek/shared/effect-adapter";
import { bitwiseOr } from "#typepeek/shared/integer-bits";

export interface ResolutionFileSystem {
  readonly directoryExists: (path: string) => boolean;
  readonly fileExists: (path: string) => boolean;
  readonly readFile: (path: string) => string | undefined;
  readonly realpath: (path: string) => string;
  readonly getDirectories: (path: string) => string[];
}

let fixtureSessions = createCompilerSessionOwner();
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
  fixtureSessions.retain(api);

  return bindCompilerProgram(program, api);
};

/** Owns one native API process and its remote resources for an inspection. */
export class CompilerSession {
  readonly api: API;
  private fileSystem: ResolutionFileSystem | undefined;
  private callbackError: { readonly error: unknown } | null = null;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly fileSystemGate = Semaphore.makeUnsafe(1);
  private readonly owner: CompilerSessionOwner;

  constructor(
    cwd = process.cwd(),
    owner: CompilerSessionOwner = fixtureSessions
  ) {
    this.owner = owner;

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

    this.owner.retain(this);
  }

  async withFileSystem<Value>(
    fileSystem: ResolutionFileSystem,
    run: () => Value | Promise<Value>
  ): Promise<Value> {
    return await runAdapterEffect(
      this.fileSystemGate.withPermit(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            if (this.closed) {
              throw new Error("The compiler session is closed.");
            }

            const previous = this.fileSystem;
            this.fileSystem = fileSystem;

            return previous;
          }),
          () =>
            Effect.promise(async () => {
              const result = await run();

              if (this.callbackError !== null) {
                throw this.callbackError.error;
              }

              return result;
            }),
          (previous) =>
            Effect.sync(() => {
              this.fileSystem = previous;
              this.callbackError = null;
            })
        )
      )
    );
  }

  retainProgram(program: Program): Program {
    return bindCompilerProgram(program, this.api);
  }

  async close(): Promise<void> {
    this.closing ??= runAdapterEffect(
      this.fileSystemGate.withPermit(
        Effect.promise(async () => {
          this.closed = true;
          this.owner.release(this);
          await this.api.close();
        })
      )
    );

    await this.closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export const closeCompilerSessions = async (): Promise<void> => {
  const previous = fixtureSessions;
  fixtureSessions = createCompilerSessionOwner();
  await previous.close();
};

const compilerSessionFor = (checker: Checker): { readonly api: API } => {
  const session = checkerSessions.get(checker);

  if (session === undefined) {
    throw new Error("The compiler checker has no active native session.");
  }

  return session;
};

export const declarationsOf = async (
  symbol: CompilerSymbol | undefined
): Promise<readonly Declaration[]> => {
  if (symbol === undefined) {
    return [];
  }

  let declarations = declarationCache.get(symbol);

  if (declarations === undefined) {
    const mappedValues = await mapAsync(symbol.declarations, async (handle) => {
      const declaration = await handle.resolve();

      return declaration === undefined ? [] : [declaration];
    });

    declarations = mappedValues.flat();
    declarationCache.set(symbol, declarations);
  }

  return declarations;
};

export const valueDeclarationOf = async (
  symbol: CompilerSymbol
): Promise<Declaration | undefined> => await symbol.valueDeclaration?.resolve();

export const printCompilerNode = async (
  checker: Checker,
  node: Node
): Promise<string> =>
  await compilerSessionFor(checker).api.printer.printNode(node);

/** These independent metadata queries share one native round trip. */
export const signatureParts = async (
  checker: Checker,
  signature: Signature
) => {
  compilerSessionFor(checker);

  const [parameters, typeParameters, thisParameter] = await runAdapterEffect(
    Effect.all(
      [
        Effect.promise(async () => await signature.getParameters()),
        Effect.promise(async () => await signature.getTypeParameters()),
        Effect.promise(async () => await signature.getThisParameter()),
      ],
      { concurrency: "unbounded" }
    )
  );

  return { parameters, thisParameter, typeParameters: typeParameters ?? [] };
};

export const signatureText = async (
  checker: Checker,
  signature: Signature,
  location?: Node,
  kind = SignatureKind.Call
): Promise<string> => {
  const node = await checker.signatureToSignatureDeclaration(
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

  const printCompilerNodeResult = await printCompilerNode(checker, node);

  return printCompilerNodeResult.trim().replace(/;$/u, "");
};

const sourceFilesOf = async (
  program: Program
): Promise<readonly SourceFile[]> => {
  const names = await program.getSourceFileNames();

  const sources = await mapAsync(
    names,
    async (file) => await program.getSourceFile(file)
  );

  return sources.filter((source): source is SourceFile => source !== undefined);
};

export const ambientModules = async (
  checker: Checker
): Promise<readonly CompilerSymbol[]> => {
  const cached = ambientModuleCache.get(checker);

  if (cached !== undefined) {
    return cached;
  }

  const program = checkerPrograms.get(checker);

  if (program === undefined) {
    throw new Error("Ambient modules need an active program.");
  }

  const sourceFilesOfResult = await sourceFilesOf(program);

  const declarations = sourceFilesOfResult.flatMap((file) =>
    file.statements.filter(
      (statement) =>
        isModuleDeclaration(statement) &&
        isStringLiteralLikeNode(statement.name)
    )
  );

  const symbols = await symbolsAtLocations(
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

export const emptyArgumentsType = async (checker: Checker) => {
  const source = await checkerPrograms
    .get(checker)
    ?.getSourceFile(COMPILER_INTRINSIC_FILE);

  const declaration = source?.statements[0];

  if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
    throw new Error("The native program is missing its intrinsic tuple.");
  }

  return await checker.getTypeFromTypeNode(declaration.type);
};
