import { createRequire } from "node:module";
import nodePath from "node:path";

import {
  isExportDeclaration,
  isFunctionTypeNode,
  isImportDeclaration,
  isVariableDeclaration,
  ScriptTarget,
} from "tsrs/ast";
import { createFileSystemLayer } from "tsrs/fs";
import {
  API,
  ModuleKind,
  ModuleResolutionKind,
  SignatureKind,
  SymbolFlags,
} from "tsrs/sync";
import type {
  Checker,
  RawCompilerOptions,
  Symbol as CompilerSymbol,
} from "tsrs/sync";

import {
  COMPILER_EXECUTABLE,
  COMPILER_VERSION,
} from "#typepeek/inspection/compiler/compiler-distribution";
import {
  bindCompilerProgram,
  declarationsOf,
  valueDeclarationOf,
  signatureText,
} from "#typepeek/inspection/compiler/compiler-session";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

import { signatureFact } from "./signature.ts";
import type { DiscoveryWorkload } from "./workloads.ts";

export interface CompilerAnswer {
  readonly facts: readonly string[];
  readonly files: readonly string[];
  readonly compilerVersion: string;
  readonly declarations: readonly {
    readonly fact: string;
    readonly text: string;
  }[];
  readonly exportDeclarations: readonly string[];
}

const publicSignatures = function publicSignatures(
  checker: Checker,
  exports: readonly CompilerSymbol[],
  name: string
): readonly {
  readonly fact: string;
  readonly text: string;
}[] {
  const exported = exports.find((symbol) => symbol.name === name);

  if (exported === undefined) {
    throw new Error(`No public export ${name}.`);
  }

  const symbol = bitwiseAnd(exported.flags, SymbolFlags.Alias)
    ? checker.getAliasedSymbol(exported)
    : exported;

  const declaration = valueDeclarationOf(symbol) ?? declarationsOf(symbol)[0];

  if (declaration === undefined) {
    throw new Error(`No declaration for ${name}.`);
  }

  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);

  return [SignatureKind.Call, SignatureKind.Construct].flatMap((kind) =>
    checker.getSignaturesOfType(type, kind).map((signature) => {
      const source = signature.declaration?.resolve();

      if (source === undefined) {
        throw new Error(`No source declaration for ${name}.`);
      }

      const witness =
        isFunctionTypeNode(source) && isVariableDeclaration(source.parent)
          ? source.parent
          : source;

      return {
        fact: signatureFact(
          kind === SignatureKind.Call ? "call" : "construct",
          signatureText(
            checker,
            signature,
            signature.declaration?.resolve(),
            kind
          )
        ),
        text: witness.getText(),
      };
    })
  );
};

const exportIndex = function exportIndex(
  checker: Checker,
  moduleSymbol: CompilerSymbol
): readonly string[] {
  const seen = new Set<CompilerSymbol>();
  const texts = new Set<string>();

  const visit = (symbol: CompilerSymbol): void => {
    if (seen.has(symbol)) {
      return;
    }

    seen.add(symbol);

    for (const declaration of declarationsOf(symbol) ?? []) {
      texts.add(declaration.getText());
      declaration.forEachChild((node) => {
        if (
          isExportDeclaration(node) &&
          node.exportClause === undefined &&
          node.moduleSpecifier !== undefined
        ) {
          const target = checker.getSymbolAtLocation(node.moduleSpecifier);

          if (target === undefined) {
            throw new Error("Cannot resolve export-star evidence.");
          }

          visit(target);
        }
      });
    }
  };

  visit(moduleSymbol);

  return [...texts];
};

export const inspectWithCompiler = function inspectWithCompiler(
  workspace: string,
  workload: DiscoveryWorkload
): CompilerAnswer {
  const probePath = nodePath.resolve(
    workspace,
    "__typepeek_benchmark_consumer__.mts"
  );

  const probeText = `import * as target from ${JSON.stringify(workload.specifier)}; void target;`;

  const options: RawCompilerOptions = {
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ScriptTarget.ES2024,
    typeRoots: [
      nodePath.join(nodePath.resolve(workspace), "node_modules", "@types"),
    ],
    types: [],
  };

  const roots = [probePath];

  if (workload.specifier.startsWith("node:")) {
    const require = createRequire(
      nodePath.join(nodePath.resolve(workspace), "package.json")
    );

    roots.push(
      nodePath.join(
        nodePath.dirname(require.resolve("@types/node/package.json")),
        "index.d.ts"
      )
    );
  }

  using api = new API({
    cwd: nodePath.resolve(workspace),
    runExternalCode: false,
    tsserverPath: COMPILER_EXECUTABLE,
  });

  const snapshot = api.createSnapshot({
    createPrograms: [{ compilerOptions: options, rootFiles: roots }],
    fileSystem: createFileSystemLayer([[probePath, probeText]]),
  });

  const created = snapshot.operation?.createdPrograms?.[0];

  if (created === undefined) {
    throw new Error("The native benchmark program is missing.");
  }

  const program = bindCompilerProgram(created, api);
  const probe = program.getSourceFile(probePath);

  if (probe === undefined) {
    throw new Error("Compiler probe was not materialized.");
  }

  const diagnostics = program.getSemanticDiagnostics(probe.fileName);

  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((item) => item.text).join("\n"));
  }

  const [importDeclaration] = probe.statements;

  if (
    importDeclaration === undefined ||
    !isImportDeclaration(importDeclaration)
  ) {
    throw new Error("Compiler probe has no import.");
  }

  const { checker } = program.getProject();

  const moduleSymbol = checker.getSymbolAtLocation(
    importDeclaration.moduleSpecifier
  );

  if (moduleSymbol === undefined) {
    throw new Error(`Cannot resolve ${workload.specifier} from ${workspace}.`);
  }

  const exports = checker.getExportsOfModule(moduleSymbol);

  const declarations =
    workload.kind === "search"
      ? []
      : publicSignatures(checker, exports, workload.target);

  const facts =
    workload.kind === "search"
      ? exports
          .map((symbol) => symbol.name)
          .filter((name) =>
            name.toLowerCase().includes(workload.target.toLowerCase())
          )
          .toSorted()
      : declarations.map(({ fact }) => fact);

  if (
    workload.expectedCount !== undefined &&
    facts.length !== workload.expectedCount
  ) {
    throw new Error(
      `${workload.id}: installed interface changed; expected ${workload.expectedCount} facts, got ${facts.length}. Review the workload before benchmarking.`
    );
  }

  return {
    compilerVersion: COMPILER_VERSION,
    declarations,
    exportDeclarations:
      workload.kind === "search" ? exportIndex(checker, moduleSymbol) : [],
    facts,
    files: program
      .getSourceFileNames()
      .filter((path) => path !== probePath)
      .toSorted(),
  };
};
