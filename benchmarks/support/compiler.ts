import { createRequire } from "node:module";
import nodePath from "node:path";

import {
  isExportDeclaration,
  isFunctionTypeNode,
  isImportDeclaration,
  isVariableDeclaration,
  ScriptTarget,
} from "tsrs/ast";
import {
  API,
  ModuleKind,
  ModuleResolutionKind,
  SignatureKind,
  SymbolFlags,
} from "tsrs/async";
import type {
  Checker,
  RawCompilerOptions,
  Symbol as CompilerSymbol,
} from "tsrs/async";
import { createFileSystemLayer } from "tsrs/fs";

import { COMPILER_EXECUTABLE } from "#typepeek/inspection/compiler/compiler-distribution";
import { COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-metadata";
import {
  bindCompilerProgram,
  declarationsOf,
  valueDeclarationOf,
  signatureText,
} from "#typepeek/inspection/compiler/compiler-session";
import { forEachChildAsync } from "#typepeek/inspection/compiler/compiler-traversal";
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

const publicSignatures = async function publicSignatures(
  checker: Checker,
  exports: readonly CompilerSymbol[],
  name: string
): Promise<
  readonly {
    readonly fact: string;
    readonly text: string;
  }[]
> {
  const exported = exports.find((symbol) => symbol.name === name);

  if (exported === undefined) {
    throw new Error(`No public export ${name}.`);
  }

  const symbol = bitwiseAnd(exported.flags, SymbolFlags.Alias)
    ? await checker.getAliasedSymbol(exported)
    : exported;

  let declaration = await valueDeclarationOf(symbol);

  if (declaration === undefined) {
    const declarations = await declarationsOf(symbol);
    [declaration] = declarations;
  }

  if (declaration === undefined) {
    throw new Error(`No declaration for ${name}.`);
  }

  const type = await checker.getTypeOfSymbolAtLocation(symbol, declaration);

  const mappedValues = await Array.fromAsync(
    [SignatureKind.Call, SignatureKind.Construct],
    async (kind) =>
      await Array.fromAsync(
        await checker.getSignaturesOfType(type, kind),
        async (signature) => {
          const source = await signature.declaration?.resolve();

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
              await signatureText(
                checker,
                signature,
                await signature.declaration?.resolve(),
                kind
              )
            ),
            text: witness.getText(),
          };
        }
      )
  );

  return mappedValues.flat();
};

const exportIndex = async function exportIndex(
  checker: Checker,
  moduleSymbol: CompilerSymbol
): Promise<readonly string[]> {
  const seen = new Set<CompilerSymbol>();
  const texts = new Set<string>();

  const visit = async (symbol: CompilerSymbol): Promise<void> => {
    if (seen.has(symbol)) {
      return;
    }

    seen.add(symbol);

    await Array.fromAsync(
      (await declarationsOf(symbol)) ?? [],
      async (declaration) => {
        texts.add(declaration.getText());
        await forEachChildAsync(declaration, async (node) => {
          if (
            isExportDeclaration(node) &&
            node.exportClause === undefined &&
            node.moduleSpecifier !== undefined
          ) {
            const target = await checker.getSymbolAtLocation(
              node.moduleSpecifier
            );

            if (target === undefined) {
              throw new Error("Cannot resolve export-star evidence.");
            }

            await visit(target);
          }
        });
      }
    );
  };

  await visit(moduleSymbol);

  return [...texts];
};

export const inspectWithCompiler = async function inspectWithCompiler(
  workspace: string,
  workload: DiscoveryWorkload
): Promise<CompilerAnswer> {
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

  await using api = new API({
    cwd: nodePath.resolve(workspace),
    runExternalCode: false,
    tsserverPath: COMPILER_EXECUTABLE,
  });

  const snapshot = await api.createSnapshot({
    createPrograms: [{ compilerOptions: options, rootFiles: roots }],
    fileSystem: createFileSystemLayer([[probePath, probeText]]),
  });

  const created = snapshot.operation?.createdPrograms?.[0];

  if (created === undefined) {
    throw new Error("The native benchmark program is missing.");
  }

  const program = bindCompilerProgram(created, api);
  const probe = await program.getSourceFile(probePath);

  if (probe === undefined) {
    throw new Error("Compiler probe was not materialized.");
  }

  const diagnostics = await program.getSemanticDiagnostics(probe.fileName);

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

  const moduleSymbol = await checker.getSymbolAtLocation(
    importDeclaration.moduleSpecifier
  );

  if (moduleSymbol === undefined) {
    throw new Error(`Cannot resolve ${workload.specifier} from ${workspace}.`);
  }

  const exports = await checker.getExportsOfModule(moduleSymbol);

  const declarations =
    workload.kind === "search"
      ? []
      : await publicSignatures(checker, exports, workload.target);

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

  const sourceFileNames = await program.getSourceFileNames();

  return {
    compilerVersion: COMPILER_VERSION,
    declarations,
    exportDeclarations:
      workload.kind === "search"
        ? await exportIndex(checker, moduleSymbol)
        : [],
    facts,
    files: sourceFileNames.filter((path) => path !== probePath).toSorted(),
  };
};
