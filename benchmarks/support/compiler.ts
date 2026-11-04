import { createRequire } from "node:module";
import nodePath from "node:path";

import ts from "@typescript/typescript6";

import { bitwiseAnd, bitwiseOr } from "#typepeek/integer-bits";

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
  checker: ts.TypeChecker,
  exports: readonly ts.Symbol[],
  name: string
): readonly {
  readonly fact: string;
  readonly text: string;
}[] {
  const exported = exports.find((symbol) => symbol.name === name);

  if (exported === undefined) {
    throw new Error(`No public export ${name}.`);
  }

  const symbol = bitwiseAnd(exported.flags, ts.SymbolFlags.Alias)
    ? checker.getAliasedSymbol(exported)
    : exported;

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];

  if (declaration === undefined) {
    throw new Error(`No declaration for ${name}.`);
  }

  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);

  return [ts.SignatureKind.Call, ts.SignatureKind.Construct].flatMap((kind) =>
    checker.getSignaturesOfType(type, kind).map((signature) => {
      const source = signature.getDeclaration();

      if (source === undefined) {
        throw new Error(`No source declaration for ${name}.`);
      }

      const witness =
        ts.isFunctionTypeNode(source) && ts.isVariableDeclaration(source.parent)
          ? source.parent
          : source;

      return {
        fact: signatureFact(
          kind === ts.SignatureKind.Call ? "call" : "construct",
          checker.signatureToString(
            signature,
            signature.getDeclaration(),
            bitwiseOr(
              ts.TypeFormatFlags.NoTruncation,
              ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
            ),
            kind
          )
        ),
        text: witness.getText(),
      };
    })
  );
};

const exportIndex = function exportIndex(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol
): readonly string[] {
  const seen = new Set<ts.Symbol>();
  const texts = new Set<string>();

  const visit = (symbol: ts.Symbol): void => {
    if (seen.has(symbol)) {
      return;
    }

    seen.add(symbol);

    for (const declaration of symbol.declarations ?? []) {
      texts.add(declaration.getText());
      ts.forEachChild(declaration, (node) => {
        if (
          ts.isExportDeclaration(node) &&
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

  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2024,
    typeRoots: [
      nodePath.join(nodePath.resolve(workspace), "node_modules", "@types"),
    ],
    types: [],
  };

  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => nodePath.resolve(workspace);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) =>
    path === probePath
      ? ts.createSourceFile(path, probeText, languageVersion, true)
      : defaultGetSourceFile(path, languageVersion, onError, shouldCreate);
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

  const program = ts.createProgram(roots, options, host);
  const probe = program.getSourceFile(probePath);

  if (probe === undefined) {
    throw new Error("Compiler probe was not materialized.");
  }

  const diagnostics = program.getSemanticDiagnostics(probe);

  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))
        .join("\n")
    );
  }

  const [importDeclaration] = probe.statements;

  if (
    importDeclaration === undefined ||
    !ts.isImportDeclaration(importDeclaration)
  ) {
    throw new Error("Compiler probe has no import.");
  }

  const checker = program.getTypeChecker();

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
    compilerVersion: ts.version,
    declarations,
    exportDeclarations:
      workload.kind === "search" ? exportIndex(checker, moduleSymbol) : [],
    facts,
    files: program
      .getSourceFiles()
      .map((file) => file.fileName)
      .filter((path) => path !== probePath)
      .toSorted(),
  };
};
