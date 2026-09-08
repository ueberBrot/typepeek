import ts from "@typescript/typescript6";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { signatureFact } from "./signature.ts";
import type { DiscoveryWorkload } from "./workloads.ts";

export interface CompilerAnswer {
  readonly facts: readonly string[];
  readonly files: readonly string[];
  readonly compilerVersion: string;
}

/** Independent consumer oracle: this module never imports Typepeek inspection code. */
export function inspectWithCompiler(
  workspace: string,
  workload: DiscoveryWorkload,
): CompilerAnswer {
  const probePath = resolve(workspace, "__typepeek_benchmark_consumer__.mts");
  const probeText = `import * as target from ${JSON.stringify(workload.specifier)}; void target;`;
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2024,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    typeRoots: [join(resolve(workspace), "node_modules", "@types")],
  };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => resolve(workspace);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) =>
    path === probePath
      ? ts.createSourceFile(path, probeText, languageVersion, true)
      : defaultGetSourceFile(path, languageVersion, onError, shouldCreate);
  const roots = [probePath];
  if (workload.specifier.startsWith("node:")) {
    const require = createRequire(join(resolve(workspace), "package.json"));
    roots.push(join(dirname(require.resolve("@types/node/package.json")), "index.d.ts"));
  }
  const program = ts.createProgram(roots, options, host);
  const probe = program.getSourceFile(probePath);
  if (probe === undefined) {
    throw new Error("Compiler probe was not materialized.");
  }
  const diagnostics = program.getSemanticDiagnostics(probe);
  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"),
    );
  }
  const importDeclaration = probe.statements[0];
  if (importDeclaration === undefined || !ts.isImportDeclaration(importDeclaration)) {
    throw new Error("Compiler probe has no import.");
  }
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(importDeclaration.moduleSpecifier);
  if (moduleSymbol === undefined) {
    throw new Error(`Cannot resolve ${workload.specifier} from ${workspace}.`);
  }
  const exports = checker.getExportsOfModule(moduleSymbol);
  const facts =
    workload.kind === "search"
      ? exports
          .map((symbol) => symbol.name)
          .filter((name) => name.toLowerCase().includes(workload.target.toLowerCase()))
          .sort()
      : publicSignatures(checker, exports, workload.target);
  if (workload.expectedCount !== undefined && facts.length !== workload.expectedCount) {
    throw new Error(
      `${workload.id}: installed interface changed; expected ${workload.expectedCount} facts, got ${facts.length}. Review the workload before benchmarking.`,
    );
  }
  return {
    facts,
    files: program
      .getSourceFiles()
      .map((file) => file.fileName)
      .filter((path) => path !== probePath)
      .sort(),
    compilerVersion: ts.version,
  };
}

function publicSignatures(
  checker: ts.TypeChecker,
  exports: readonly ts.Symbol[],
  name: string,
): readonly string[] {
  const exported = exports.find((symbol) => symbol.name === name);
  if (exported === undefined) {
    throw new Error(`No public export ${name}.`);
  }
  const symbol =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined) {
    throw new Error(`No declaration for ${name}.`);
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return [ts.SignatureKind.Call, ts.SignatureKind.Construct].flatMap((kind) =>
    checker
      .getSignaturesOfType(type, kind)
      .map((signature) =>
        signatureFact(
          kind === ts.SignatureKind.Call ? "call" : "construct",
          checker.signatureToString(
            signature,
            signature.getDeclaration(),
            ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
            kind,
          ),
        ),
      ),
  );
}
