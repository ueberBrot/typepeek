import ts from "@typescript/typescript6";

import { createBoundedCompilerHost } from "#typepeek/inspection/compiler-host";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";

const MAX_MODULE_EXPORTS = 200;

interface ModuleInspection {
  readonly checker: ts.TypeChecker;
  readonly moduleSymbol: ts.Symbol;
}

export function inspectModuleExports(
  declarationPath: string,
  packageRoot: string,
): readonly { readonly name: string }[] {
  const compilerOptions = getCompilerOptions();
  const program = ts.createProgram({
    rootNames: [declarationPath],
    options: compilerOptions,
    host: createBoundedCompilerHost(packageRoot, compilerOptions),
  });
  const { checker, moduleSymbol } = getModuleInspection(program, declarationPath);
  const moduleExports = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => ({ name: symbol.getName() }))
    .sort(compareModuleExports);

  if (moduleExports.length > MAX_MODULE_EXPORTS) {
    throw new InspectionLimitError("Inspection exceeded its Module Export limit.");
  }
  return moduleExports;
}

function getModuleInspection(program: ts.Program, declarationPath: string): ModuleInspection {
  const sourceFile = program.getSourceFile(declarationPath);
  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module.",
    );
  }

  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(checker, sourceFile);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module.",
    );
  }
  return { checker, moduleSymbol };
}

function assertResolvedReExportGraph(checker: ts.TypeChecker, entrypoint: ts.SourceFile): void {
  const pendingSourceFiles = [entrypoint];
  const visitedSourceFiles = new Set<string>();

  for (const sourceFile of pendingSourceFiles) {
    if (visitedSourceFiles.has(sourceFile.fileName)) {
      continue;
    }
    visitedSourceFiles.add(sourceFile.fileName);
    pendingSourceFiles.push(...reExportedSourceFiles(checker, sourceFile));
  }
}

function reExportedSourceFiles(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly ts.SourceFile[] {
  return sourceFile.statements
    .filter(hasModuleSpecifier)
    .flatMap((statement) => resolvedModuleSourceFiles(checker, statement.moduleSpecifier));
}

function hasModuleSpecifier(
  statement: ts.Statement,
): statement is ts.ExportDeclaration & { readonly moduleSpecifier: ts.Expression } {
  return ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined;
}

function resolvedModuleSourceFiles(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
): readonly ts.SourceFile[] {
  const referencedModule = checker.getSymbolAtLocation(moduleSpecifier);
  if (referencedModule === undefined) {
    throw new UnsupportedInspectionError(
      "A declaration re-export could not be resolved from Installed Evidence.",
    );
  }
  return (referencedModule.declarations ?? []).filter(ts.isSourceFile);
}

function getCompilerOptions(): ts.CompilerOptions {
  return {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    // An Interface Overview only indexes module declarations. Omitting ambient
    // libraries keeps unrelated standard-library evidence out of this bounded pass.
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2024,
    types: [],
  };
}

function compareModuleExports(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
