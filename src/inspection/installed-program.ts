import ts from "@typescript/typescript6";
import { opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  canonicalEvidenceCandidatePath,
  isPathWithin,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence-boundary";
import {
  canonicalPackageBoundary,
  canonicalPath,
  declarationProviderSegments,
  findMaterializedPackageRoot,
  findVisiblePackageForDependency,
  type PackageBoundaryObserver,
  parsePackageNameSegments,
  readInstalledManifest,
} from "#typepeek/inspection/installed-package-boundary";
import { selectNodeDeclarationProgram } from "#typepeek/inspection/node-declaration-authority";
import type { InspectionPlanQuery } from "#typepeek/inspection/protocol";
import {
  INSPECTION_STANDARD_LIBRARY,
  isTypeScriptStandardLibraryDeclaration,
} from "#typepeek/inspection/typescript-standard-library";

const MAX_SOURCE_FILES = 384;
const MAX_DECLARATION_GRAPH_DEPTH = 256;
const MAX_DECLARATION_GRAPH_NODES = 250_000;

interface CompilerHostState {
  readonly defaultHost: ts.CompilerHost;
  readonly allowedPackageRoots: Set<string>;
  readonly typeReferenceResolutions: Map<
    string,
    ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations
  >;
  readonly packageManifestCache: Map<string, Readonly<Record<string, unknown>>>;
  readonly fileExistsCache: Map<string, boolean>;
  readonly readFileCache: Map<string, string | undefined>;
  readonly directoryExistsCache: Map<string, boolean>;
  readonly directoriesCache: Map<string, string[]>;
  readonly realpathCache: Map<string, string>;
  readonly sourceFileCache: Map<string, ts.SourceFile | undefined>;
  readonly compilerWorkSession: CompilerWorkSession;
  sourceFileCount: number;
  sourceByteCount: number;
}

interface PackageRootCapability {
  readonly canonicalRoot: string;
  readonly logicalRoot: string;
}

interface BoundedCompilerHost extends ts.CompilerHost {
  readonly allowPackageRoot: (packageRoot: string) => void;
  readonly findProgramSourceFile: (
    program: ts.Program,
    fileName: string,
  ) => ts.SourceFile | undefined;
  readonly packageBoundaryObserver: PackageBoundaryObserver;
  readonly resolveTypeReferenceDirectiveReferences: NonNullable<
    ts.CompilerHost["resolveTypeReferenceDirectiveReferences"]
  >;
}

interface DeclarationGraphTraversalState {
  nodeCount: number;
}

interface PendingDeclarationGraphEntry {
  readonly declaration: ts.Declaration;
  readonly expandSourceExports: boolean;
}

interface ReExportGraphState {
  readonly pendingEntries: PendingDeclarationGraphEntry[];
  readonly visitedDeclarations: Set<ts.Declaration>;
  readonly visitedExpandedSourceFiles: Set<string>;
  readonly visitedReferenceSourceFiles: Set<string>;
}

export type InstalledProgramSelection = {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly declarationPath: string;
  readonly declarationRoot: string;
  readonly logicalDeclarationRoot: string;
  readonly resolutionContextDirectory: string;
  readonly readNodeDeclarationProvider: () =>
    | {
        readonly declarationPath: string;
        readonly declarationRoot: string;
        readonly logicalDeclarationRoot: string;
      }
    | undefined;
} & (
  | { readonly kind: "package"; readonly ambientSpecifier: string | undefined }
  | { readonly kind: "platform"; readonly specifier: string }
);

export interface InstalledProgramEvidence {
  readonly checker: ts.TypeChecker;
  readonly moduleSymbol: ts.Symbol;
}

interface InstalledProgramRequirements {
  readonly focusedExportNames: readonly string[];
  readonly needsNodeAugmentation: boolean;
  readonly nodeAugmentationExportName: string | undefined;
}

type NodeAugmentationScope = "none" | "complete-module" | "focused-export";

const NODE_AUGMENTATION_SCOPE_BY_QUERY = {
  "interface-overview": "complete-module",
  "export-inspection": "focused-export",
  "signature-inspection": "none",
  "export-search": "complete-module",
  "public-subpath-discovery": "none",
  "declaration-inspection": "focused-export",
  "member-inspection": "focused-export",
} as const satisfies Readonly<Record<InspectionPlanQuery["intent"], NodeAugmentationScope>>;

/** Materializes and validates one bounded TypeScript declaration program. */
export function materializeInstalledProgram(
  selection: InstalledProgramSelection,
  queries: readonly InspectionPlanQuery[],
): InstalledProgramEvidence {
  const requirements = installedProgramRequirements(queries);
  const traversal: DeclarationGraphTraversalState = { nodeCount: 0 };
  const compilerOptions = inspectionCompilerOptions();
  const host = createBoundedCompilerHost(
    [selection.declarationRoot, selection.logicalDeclarationRoot],
    selection.resolutionContextDirectory,
    compilerOptions,
    selection.compilerWorkSession,
  );
  const initialProgram = ts.createProgram({
    rootNames: [selection.declarationPath],
    options: compilerOptions,
    host,
  });
  const initialEvidence = initialPackageEvidence(initialProgram, selection);
  const publicInterfaceProgram =
    initialEvidence !== undefined &&
    requirements.focusedExportNames.some((exportName) =>
      selectedExportNeedsStandardLibrary(
        initialProgram.getTypeChecker(),
        initialEvidence.moduleSymbol,
        exportName,
      ),
    )
      ? ts.createProgram({
          rootNames: [selection.declarationPath],
          options: inspectionCompilerOptions(true),
          host,
        })
      : initialProgram;
  const initialSourceFile = publicInterfaceProgram.getSourceFile(selection.declarationPath);
  const initialModuleSymbol =
    selection.kind === "package" && initialSourceFile !== undefined
      ? packageModuleSymbol(
          publicInterfaceProgram.getTypeChecker(),
          initialSourceFile,
          selection.ambientSpecifier,
        )
      : undefined;
  const nodeProgram =
    selection.kind === "platform" ||
    !requirements.needsNodeAugmentation ||
    initialSourceFile === undefined ||
    initialModuleSymbol === undefined
      ? undefined
      : selectNodeDeclarationProgram(
          publicInterfaceProgram,
          initialModuleSymbol,
          initialSourceFile,
          () => {
            const nodeProvider = selection.readNodeDeclarationProvider();
            if (nodeProvider === undefined) {
              return undefined;
            }
            host.allowPackageRoot(nodeProvider.declarationRoot);
            host.allowPackageRoot(nodeProvider.logicalDeclarationRoot);
            return {
              program: ts.createProgram({
                rootNames: [selection.declarationPath, nodeProvider.declarationPath],
                options: compilerOptions,
                host,
              }),
              providerRoot: nodeProvider.declarationRoot,
            };
          },
          () => reserveDeclarationGraphNodes(traversal, 1),
          requirements.nodeAugmentationExportName,
        );
  const program = nodeProgram ?? publicInterfaceProgram;
  return inspectSelectedModule(program, selection, host, traversal);
}

function installedProgramRequirements(
  queries: readonly InspectionPlanQuery[],
): InstalledProgramRequirements {
  const focusedExportNames: string[] = [];
  const nodeAugmentationExportNames = new Set<string>();
  let needsNodeAugmentation = false;
  let nodeAugmentationRequiresCompleteModule = false;

  for (const query of queries) {
    if ("exportName" in query) {
      focusedExportNames.push(query.exportName);
    }
    const augmentationScope = NODE_AUGMENTATION_SCOPE_BY_QUERY[query.intent];
    if (augmentationScope === "none") {
      continue;
    }
    needsNodeAugmentation = true;
    if (augmentationScope === "complete-module") {
      nodeAugmentationRequiresCompleteModule = true;
    } else if ("exportName" in query) {
      nodeAugmentationExportNames.add(query.exportName);
    }
  }

  return {
    focusedExportNames,
    needsNodeAugmentation,
    nodeAugmentationExportName:
      !nodeAugmentationRequiresCompleteModule && nodeAugmentationExportNames.size === 1
        ? nodeAugmentationExportNames.values().next().value
        : undefined,
  };
}

function initialPackageEvidence(
  program: ts.Program,
  selection: InstalledProgramSelection,
): { readonly moduleSymbol: ts.Symbol } | undefined {
  if (selection.kind !== "package") {
    return undefined;
  }
  const sourceFile = program.getSourceFile(selection.declarationPath);
  const moduleSymbol =
    sourceFile === undefined
      ? undefined
      : packageModuleSymbol(program.getTypeChecker(), sourceFile, selection.ambientSpecifier);
  return moduleSymbol === undefined ? undefined : { moduleSymbol };
}

function selectedExportNeedsStandardLibrary(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  exportName: string,
): boolean {
  const exportedSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);
  if (exportedSymbol === undefined) {
    return false;
  }
  const symbol =
    exportedSymbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exportedSymbol)
      : exportedSymbol;
  return (
    selectedValueNeedsStandardLibrary(checker, symbol) ||
    (symbol.declarations ?? []).some(
      (declaration) =>
        ts.isClassDeclaration(declaration) &&
        inheritedConstructorNeedsStandardLibrary(checker, declaration, new Set(), 0),
    )
  );
}

function selectedValueNeedsStandardLibrary(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
    return false;
  }
  const type = declaration.type;
  const typeSymbol =
    type !== undefined && ts.isTypeReferenceNode(type)
      ? checker.getSymbolAtLocation(type.typeName)
      : undefined;
  return (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    (typeSymbol === undefined || (typeSymbol.declarations ?? []).length === 0)
  );
}

function inheritedConstructorNeedsStandardLibrary(
  checker: ts.TypeChecker,
  declaration: ts.ClassDeclaration,
  visited: Set<ts.ClassDeclaration>,
  depth: number,
): boolean {
  if (
    declaration.members.some(ts.isConstructorDeclaration) ||
    visited.has(declaration) ||
    depth > 64
  ) {
    return false;
  }
  visited.add(declaration);
  return (declaration.heritageClauses ?? []).some((clause) =>
    clause.types.some((heritage) => {
      const symbol = checker.getSymbolAtLocation(heritage.expression);
      if (symbol === undefined) {
        return true;
      }
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (target.declarations ?? []).some(
        (baseDeclaration) =>
          ts.isClassDeclaration(baseDeclaration) &&
          inheritedConstructorNeedsStandardLibrary(checker, baseDeclaration, visited, depth + 1),
      );
    }),
  );
}

function inspectSelectedModule(
  program: ts.Program,
  selection: InstalledProgramSelection,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
): InstalledProgramEvidence {
  if (selection.kind === "package") {
    return inspectModuleEvidence(
      program,
      selection.declarationPath,
      selection.ambientSpecifier,
      host,
      traversal,
    );
  }
  return inspectPlatformModuleEvidence(
    program,
    selection.declarationPath,
    selection.specifier,
    host,
    traversal,
  );
}

function inspectionCompilerOptions(includeStandardLibrary = false): ts.CompilerOptions {
  return {
    ...(includeStandardLibrary ? { lib: [INSPECTION_STANDARD_LIBRARY] } : { noLib: true }),
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2024,
    types: [],
  };
}

function inspectModuleEvidence(
  program: ts.Program,
  declarationPath: string,
  ambientSpecifier: string | undefined,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
): InstalledProgramEvidence {
  const sourceFile = program.getSourceFile(declarationPath);
  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module.",
    );
  }

  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(program, checker, sourceFile, host, traversal);
  const moduleSymbol = packageModuleSymbol(checker, sourceFile, ambientSpecifier);
  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module.",
    );
  }
  assertResolvedAmbientModuleReExports(program, checker, moduleSymbol, host, traversal);
  return { checker, moduleSymbol };
}

function packageModuleSymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  ambientSpecifier: string | undefined,
): ts.Symbol | undefined {
  const sourceFileSymbol = checker.getSymbolAtLocation(sourceFile);
  if (sourceFileSymbol !== undefined || ambientSpecifier === undefined) {
    return sourceFileSymbol;
  }
  return checker
    .getAmbientModules()
    .find((symbol) => ambientModuleName(symbol) === ambientSpecifier);
}

function inspectPlatformModuleEvidence(
  program: ts.Program,
  declarationPath: string,
  specifier: string,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
): InstalledProgramEvidence {
  const sourceFile = program.getSourceFile(declarationPath);
  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The visible Declaration Provider has no readable module declarations.",
    );
  }
  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(program, checker, sourceFile, host, traversal);
  const moduleSymbol = checker
    .getAmbientModules()
    .find((symbol) => ambientModuleName(symbol) === specifier);
  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${specifier}" is not declared by the visible @types/node provider.`,
    );
  }
  assertResolvedAmbientModuleReExports(program, checker, moduleSymbol, host, traversal);
  return { checker, moduleSymbol };
}

function ambientModuleName(symbol: ts.Symbol): string {
  const name = symbol.getName();
  return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
}

function assertResolvedAmbientModuleReExports(
  program: ts.Program,
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
): void {
  const pendingDeclarations: ts.Declaration[] = (moduleSymbol.declarations ?? []).filter(
    ts.isModuleDeclaration,
  );
  const visitedDeclarations = new Set<ts.Declaration>();
  for (const declaration of pendingDeclarations) {
    if (visitedDeclarations.has(declaration)) {
      continue;
    }
    visitedDeclarations.add(declaration);
    pendingDeclarations.push(
      ...ambientReExportSpecifiers(declaration, traversal).flatMap((specifier) =>
        resolvedModuleDeclarations(checker, specifier),
      ),
      ...referencedDeclarationSourceFiles(program, declaration, host, traversal),
    );
  }
}

function ambientReExportSpecifiers(
  declaration: ts.Declaration,
  traversal: DeclarationGraphTraversalState,
): readonly ts.Expression[] {
  const statements = moduleBodyStatements(declaration);
  return [
    ...statements.flatMap(ambientModuleReferenceSpecifiers),
    ...statements.flatMap((statement) => descendantImportTypeSpecifiers(statement, traversal)),
  ];
}

function descendantImportTypeSpecifiers(
  root: ts.Node,
  traversal: DeclarationGraphTraversalState,
): readonly ts.Expression[] {
  const specifiers: ts.Expression[] = [];
  const visit = (node: ts.Node, depth: number): void => {
    traversal.nodeCount += 1;
    if (depth > MAX_DECLARATION_GRAPH_DEPTH || traversal.nodeCount > MAX_DECLARATION_GRAPH_NODES) {
      throw new InspectionLimitError(
        "declaration-graph",
        "Inspection exceeded its declaration graph traversal limit.",
      );
    }
    const specifier = importTypeSpecifier(node);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return specifiers;
}

function importTypeSpecifier(node: ts.Node): ts.Expression | undefined {
  if (!ts.isImportTypeNode(node)) {
    return undefined;
  }
  if (!ts.isLiteralTypeNode(node.argument)) {
    return undefined;
  }
  return ts.isStringLiteralLike(node.argument.literal) ? node.argument.literal : undefined;
}

function ambientModuleReferenceSpecifiers(statement: ts.Statement): readonly ts.Expression[] {
  if (hasModuleSpecifier(statement)) {
    return [statement.moduleSpecifier];
  }
  if (ts.isImportDeclaration(statement)) {
    return [statement.moduleSpecifier];
  }
  return ts.isImportEqualsDeclaration(statement) ? externalImportEqualsSpecifiers(statement) : [];
}

function externalImportEqualsSpecifiers(
  statement: ts.ImportEqualsDeclaration,
): readonly ts.Expression[] {
  const specifier = externalImportSpecifier(statement);
  return specifier === undefined ? [] : [specifier];
}

function externalImportSpecifier(statement: ts.ImportEqualsDeclaration): ts.Expression | undefined {
  return ts.isExternalModuleReference(statement.moduleReference)
    ? statement.moduleReference.expression
    : undefined;
}

function moduleBodyStatements(declaration: ts.Declaration): readonly ts.Statement[] {
  if (ts.isSourceFile(declaration)) {
    return declaration.statements;
  }
  return moduleDeclarationStatements(declaration);
}

function moduleDeclarationStatements(declaration: ts.Declaration): readonly ts.Statement[] {
  if (!ts.isModuleDeclaration(declaration)) {
    return [];
  }
  const { body } = declaration;
  if (body === undefined) {
    return [];
  }
  return ts.isModuleBlock(body) ? body.statements : moduleBodyStatements(body);
}

function assertResolvedReExportGraph(
  program: ts.Program,
  checker: ts.TypeChecker,
  entrypoint: ts.SourceFile,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
): void {
  // Reject unresolved re-export graphs before returning a result.
  const state: ReExportGraphState = {
    pendingEntries: [{ declaration: entrypoint, expandSourceExports: true }],
    visitedDeclarations: new Set(),
    visitedExpandedSourceFiles: new Set(),
    visitedReferenceSourceFiles: new Set(),
  };
  for (const entry of state.pendingEntries) {
    inspectReExportGraphEntry(program, checker, host, traversal, state, entry);
  }
}

function inspectReExportGraphEntry(
  program: ts.Program,
  checker: ts.TypeChecker,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  entry: PendingDeclarationGraphEntry,
): void {
  const { declaration, expandSourceExports } = entry;
  if (visitedDeclarationEntry(state, declaration, expandSourceExports)) {
    return;
  }
  enqueueReferencedDeclarationFiles(program, host, traversal, state, declaration.getSourceFile());
  if (ts.isSourceFile(declaration) && expandSourceExports) {
    expandReExportSource(checker, traversal, state, declaration);
    return;
  }
  for (const specifier of descendantImportTypeSpecifiers(declaration, traversal)) {
    resolvedModuleDeclarations(checker, specifier);
  }
}

function visitedDeclarationEntry(
  state: ReExportGraphState,
  declaration: ts.Declaration,
  expandSourceExports: boolean,
): boolean {
  const alreadyVisited = state.visitedDeclarations.has(declaration);
  state.visitedDeclarations.add(declaration);
  return alreadyVisited && (!ts.isSourceFile(declaration) || !expandSourceExports);
}

function enqueueReferencedDeclarationFiles(
  program: ts.Program,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  sourceFile: ts.SourceFile,
): void {
  if (state.visitedReferenceSourceFiles.has(sourceFile.fileName)) {
    return;
  }
  state.visitedReferenceSourceFiles.add(sourceFile.fileName);
  state.pendingEntries.push(
    ...referencedDeclarationSourceFiles(program, sourceFile, host, traversal).map(
      (referenced): PendingDeclarationGraphEntry => ({
        declaration: referenced,
        expandSourceExports: true,
      }),
    ),
  );
}

function expandReExportSource(
  checker: ts.TypeChecker,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  sourceFile: ts.SourceFile,
): void {
  if (state.visitedExpandedSourceFiles.has(sourceFile.fileName)) {
    return;
  }
  state.visitedExpandedSourceFiles.add(sourceFile.fileName);
  reserveDeclarationGraphNodes(traversal, sourceFile.statements.length);
  state.pendingEntries.push(...reExportedDeclarations(checker, sourceFile));
}

function referencedDeclarationSourceFiles(
  program: ts.Program,
  declaration: ts.Declaration,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
): readonly ts.SourceFile[] {
  if (!ts.isSourceFile(declaration)) {
    return [];
  }
  reserveDeclarationGraphNodes(
    traversal,
    declaration.referencedFiles.length + declaration.typeReferenceDirectives.length,
  );
  return [
    ...declaration.referencedFiles.map((reference) =>
      requiredProgramSourceFile(
        program,
        resolve(dirname(declaration.fileName), reference.fileName),
        host,
      ),
    ),
    ...declaration.typeReferenceDirectives.map((reference) =>
      resolvedTypeReferenceSourceFile(program, declaration, reference.fileName, host),
    ),
  ];
}

function reserveDeclarationGraphNodes(
  traversal: DeclarationGraphTraversalState,
  count: number,
): void {
  traversal.nodeCount += count;
  if (traversal.nodeCount > MAX_DECLARATION_GRAPH_NODES) {
    throw new InspectionLimitError(
      "declaration-graph",
      "Inspection exceeded its declaration graph traversal limit.",
    );
  }
}

function resolvedTypeReferenceSourceFile(
  program: ts.Program,
  containingFile: ts.SourceFile,
  typeReferenceName: string,
  host: BoundedCompilerHost,
): ts.SourceFile {
  const resolution = host.resolveTypeReferenceDirectiveReferences(
    [typeReferenceName],
    containingFile.fileName,
    undefined,
    program.getCompilerOptions(),
    undefined,
    undefined,
  )[0]?.resolvedTypeReferenceDirective;
  const resolvedFileName = resolution?.resolvedFileName;
  if (resolvedFileName === undefined) {
    throw unresolvedDeclarationReference();
  }
  return requiredProgramSourceFile(program, resolvedFileName, host);
}

function requiredProgramSourceFile(
  program: ts.Program,
  fileName: string,
  host: BoundedCompilerHost,
): ts.SourceFile {
  const sourceFile = host.findProgramSourceFile(program, fileName);
  if (sourceFile === undefined) {
    throw unresolvedDeclarationReference();
  }
  return sourceFile;
}

function unresolvedDeclarationReference(): UnsupportedInspectionError {
  return new UnsupportedInspectionError(
    "A declaration re-export could not be resolved from Installed Evidence.",
  );
}

function reExportedDeclarations(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly PendingDeclarationGraphEntry[] {
  return sourceFile.statements
    .filter(hasModuleSpecifier)
    .flatMap((statement) => reExportedStatementDeclarations(checker, statement));
}

function reExportedStatementDeclarations(
  checker: ts.TypeChecker,
  statement: ts.ExportDeclaration & { readonly moduleSpecifier: ts.Expression },
): readonly PendingDeclarationGraphEntry[] {
  if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
    return statement.exportClause.elements.flatMap((element) => {
      const symbol = checker.getSymbolAtLocation(element.name);
      const resolved =
        symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      const declarations = resolved?.declarations ?? [];
      if (declarations.length === 0) {
        throw unresolvedDeclarationReference();
      }
      return declarations.map(
        (declaration): PendingDeclarationGraphEntry => ({
          declaration,
          expandSourceExports: false,
        }),
      );
    });
  }
  return resolvedModuleSourceFiles(checker, statement.moduleSpecifier).map(
    (declaration): PendingDeclarationGraphEntry => ({
      declaration,
      expandSourceExports: true,
    }),
  );
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
  return resolvedModuleDeclarations(checker, moduleSpecifier).filter(ts.isSourceFile);
}

function resolvedModuleDeclarations(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
): readonly ts.Declaration[] {
  const referencedModule = checker.getSymbolAtLocation(moduleSpecifier);
  if (referencedModule === undefined) {
    throw new UnsupportedInspectionError(
      "A declaration re-export could not be resolved from Installed Evidence.",
    );
  }
  const declarations = referencedModule.declarations ?? [];
  if (declarations.length === 0) {
    throw new UnsupportedInspectionError(
      "A declaration re-export could not be resolved from Installed Evidence.",
    );
  }
  return declarations;
}

function createBoundedCompilerHost(
  packageRoots: readonly string[],
  resolutionContextDirectory: string,
  compilerOptions: ts.CompilerOptions,
  compilerWorkSession: CompilerWorkSession,
): BoundedCompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const readOnlyDefaultHost = withoutCompilerDirectoryReader(defaultHost);
  const rejectCompilerWrite = (): never => {
    throw new UnsupportedInspectionError("Inspection cannot emit compiler output.");
  };
  const resolutionHostBase: ts.CompilerHost = {
    ...readOnlyDefaultHost,
    getCurrentDirectory: () => resolutionContextDirectory,
    writeFile: rejectCompilerWrite,
  };
  const authorizedPackageRoots = packageRoots.flatMap((packageRoot) => {
    const canonicalPackageRoot = canonicalPath(packageRoot);
    if (canonicalPackageRoot === undefined) {
      throw new UnsupportedInspectionError(
        "The installed package boundary could not be canonicalized.",
      );
    }
    return [resolve(packageRoot), canonicalPackageRoot];
  });
  if (authorizedPackageRoots.length === 0) {
    throw new UnsupportedInspectionError("The installed package boundary is missing.");
  }
  const state: CompilerHostState = {
    defaultHost: resolutionHostBase,
    allowedPackageRoots: new Set(authorizedPackageRoots),
    typeReferenceResolutions: new Map(),
    packageManifestCache: new Map(),
    fileExistsCache: new Map(),
    readFileCache: new Map(),
    directoryExistsCache: new Map(),
    directoriesCache: new Map(),
    realpathCache: new Map(),
    sourceFileCache: new Map(),
    compilerWorkSession,
    sourceFileCount: 0,
    sourceByteCount: 0,
  };
  const resolutionHost = createBoundedResolutionHost(state);
  const packageBoundaryObserver = createPackageBoundaryObserver(state);
  const programSourceFiles = new WeakMap<ts.Program, ReadonlyMap<string, ts.SourceFile>>();

  // Bare imports may add compiler-resolved roots to this allowlist.
  return {
    ...readOnlyDefaultHost,
    allowPackageRoot: (packageRoot) => {
      state.allowedPackageRoots.add(canonicalPackageBoundary(packageRoot, packageBoundaryObserver));
      state.typeReferenceResolutions.clear();
    },
    getCurrentDirectory: () => resolutionContextDirectory,
    writeFile: rejectCompilerWrite,
    findProgramSourceFile: (program, fileName) => {
      reserveCompilerHostOperations(state, 1);
      let sourceFiles = programSourceFiles.get(program);
      if (sourceFiles === undefined) {
        const indexedSourceFiles = new Map<string, ts.SourceFile>();
        for (const sourceFile of program.getSourceFiles()) {
          if (!isAuthorizedSourceCandidate(state.allowedPackageRoots, sourceFile.fileName)) {
            continue;
          }
          const canonicalFileName = canonicalPath(sourceFile.fileName, packageBoundaryObserver);
          if (canonicalFileName !== undefined) {
            indexedSourceFiles.set(canonicalFileName, sourceFile);
          }
        }
        sourceFiles = indexedSourceFiles;
        programSourceFiles.set(program, sourceFiles);
      }
      if (!isAuthorizedSourceCandidate(state.allowedPackageRoots, fileName)) {
        throw new StaticBoundaryInspectionError(
          "A declaration references source outside its installed package boundary.",
        );
      }
      const canonicalFileName = canonicalPath(fileName, packageBoundaryObserver);
      return canonicalFileName === undefined ? undefined : sourceFiles.get(canonicalFileName);
    },
    packageBoundaryObserver,
    fileExists: (fileName) => resolutionHost.fileExists(fileName),
    readFile: (fileName) => resolutionHost.readFile(fileName),
    ...(resolutionHost.directoryExists === undefined
      ? {}
      : {
          directoryExists: (directoryName: string) =>
            resolutionHost.directoryExists!(directoryName),
        }),
    ...(resolutionHost.getDirectories === undefined
      ? {}
      : {
          getDirectories: (directoryName: string) => resolutionHost.getDirectories!(directoryName),
        }),
    ...(resolutionHost.realpath === undefined
      ? {}
      : { realpath: (path: string) => resolutionHost.realpath!(path) }),
    resolveModuleNameLiterals: (
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
      containingSourceFile,
    ) =>
      moduleLiterals.map((moduleLiteral) =>
        resolveModuleLiteral(
          state,
          moduleLiteral,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile,
        ),
      ),
    resolveTypeReferenceDirectiveReferences: (
      typeDirectiveReferences,
      containingFile,
      redirectedReference,
      options,
    ) =>
      typeDirectiveReferences.map((reference) =>
        resolveTypeReferenceDirectiveReference(
          state,
          reference,
          containingFile,
          redirectedReference,
          options,
        ),
      ),
    getSourceFile: (fileName, languageVersion, onError) =>
      getBoundedSourceFile(state, fileName, languageVersion, onError),
  };
}

function withoutCompilerDirectoryReader(
  host: ts.CompilerHost,
): Omit<ts.CompilerHost, "readDirectory"> {
  const readOnlyHost = { ...host };
  delete readOnlyHost.readDirectory;
  return readOnlyHost;
}

function createBoundedResolutionHost(
  state: CompilerHostState,
  allowedRoots: ReadonlySet<string> = state.allowedPackageRoots,
): ts.ModuleResolutionHost {
  const { defaultHost } = state;
  return {
    fileExists: (fileName) => {
      assertNoResolutionSymlinkEscape(allowedRoots, fileName);
      return (
        isAuthorizedResolutionPath(allowedRoots, fileName) &&
        cachedCompilerHostResult(state, state.fileExistsCache, fileName, () =>
          defaultHost.fileExists(fileName),
        )
      );
    },
    readFile: (fileName) => {
      assertNoResolutionSymlinkEscape(allowedRoots, fileName);
      if (!isAuthorizedResolutionPath(allowedRoots, fileName)) {
        return undefined;
      }
      return cachedCompilerHostResult(state, state.readFileCache, fileName, () => {
        try {
          return state.compilerWorkSession.readResolutionFile(fileName);
        } catch (error) {
          if (error instanceof InspectionLimitError) {
            throw error;
          }
          return undefined;
        }
      });
    },
    ...(defaultHost.directoryExists === undefined
      ? {}
      : {
          directoryExists: (directoryName: string) => {
            assertNoResolutionSymlinkEscape(allowedRoots, directoryName);
            return (
              isAuthorizedResolutionDirectory(allowedRoots, directoryName) &&
              cachedCompilerHostResult(
                state,
                state.directoryExistsCache,
                directoryName,
                () => defaultHost.directoryExists?.(directoryName) ?? false,
              )
            );
          },
        }),
    ...(defaultHost.getDirectories === undefined
      ? {}
      : {
          getDirectories: (directoryName: string) => {
            assertNoResolutionSymlinkEscape(allowedRoots, directoryName);
            if (!isAuthorizedResolutionPath(allowedRoots, directoryName)) {
              return [];
            }
            return cachedCompilerHostResult(state, state.directoriesCache, directoryName, () => {
              const directories: string[] = [];
              let directory;
              try {
                directory = opendirSync(directoryName);
              } catch {
                return directories;
              }
              try {
                for (
                  let entry = directory.readSync();
                  entry !== null;
                  entry = directory.readSync()
                ) {
                  reserveCompilerHostOperations(state, 1);
                  if (entry.isDirectory()) {
                    directories.push(join(directoryName, entry.name));
                  }
                }
                return directories;
              } finally {
                directory.closeSync();
              }
            });
          },
        }),
    ...(defaultHost.realpath === undefined
      ? {}
      : {
          realpath: (path: string) => {
            assertNoResolutionSymlinkEscape(allowedRoots, path);
            return isAuthorizedResolutionPath(allowedRoots, path)
              ? cachedCompilerHostResult(
                  state,
                  state.realpathCache,
                  path,
                  () => defaultHost.realpath?.(path) ?? path,
                )
              : path;
          },
        }),
    getCurrentDirectory: () => defaultHost.getCurrentDirectory(),
    useCaseSensitiveFileNames: defaultHost.useCaseSensitiveFileNames(),
  };
}

function assertNoResolutionSymlinkEscape(
  allowedRoots: ReadonlySet<string>,
  candidate: string,
): void {
  const lexicalCandidate = resolve(candidate);
  if (![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, lexicalCandidate))) {
    return;
  }
  const canonicalCandidate = canonicalEvidenceCandidatePath(candidate);
  if (
    canonicalCandidate === undefined ||
    ![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, canonicalCandidate))
  ) {
    throw new StaticBoundaryInspectionError(
      "A declaration references source outside its installed package boundary.",
    );
  }
}

function isAuthorizedResolutionPath(allowedRoots: ReadonlySet<string>, candidate: string): boolean {
  const lexicalCandidate = resolve(candidate);
  if (![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, lexicalCandidate))) {
    return false;
  }
  const canonicalCandidate = canonicalEvidenceCandidatePath(candidate);
  return (
    canonicalCandidate !== undefined &&
    [...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, canonicalCandidate))
  );
}

function isAuthorizedResolutionDirectory(
  allowedRoots: ReadonlySet<string>,
  candidate: string,
): boolean {
  const lexicalCandidate = resolve(candidate);
  if (
    ![...allowedRoots].some(
      (allowedRoot) =>
        isPathWithin(allowedRoot, lexicalCandidate) || isPathWithin(lexicalCandidate, allowedRoot),
    )
  ) {
    return false;
  }
  const canonicalCandidate = canonicalEvidenceCandidatePath(candidate);
  return (
    canonicalCandidate !== undefined &&
    [...allowedRoots].some(
      (allowedRoot) =>
        isPathWithin(allowedRoot, canonicalCandidate) ||
        isPathWithin(canonicalCandidate, allowedRoot),
    )
  );
}

function cachedCompilerHostResult<Result>(
  state: CompilerHostState,
  cache: Map<string, Result>,
  key: string,
  read: () => Result,
): Result {
  reserveCompilerHostOperations(state, 1);
  if (cache.has(key)) {
    return cache.get(key) as Result;
  }
  const result = read();
  cache.set(key, result);
  return result;
}

function reserveCompilerHostOperations(state: CompilerHostState, count: number): void {
  state.compilerWorkSession.reserveOperations(count);
}

function createPackageBoundaryObserver(state: CompilerHostState): PackageBoundaryObserver {
  return state.compilerWorkSession.observePackageBoundary(state.packageManifestCache);
}

function resolveTypeReferenceDirectiveReference(
  state: CompilerHostState,
  reference: ts.FileReference | string,
  containingFile: string,
  redirectedReference: ts.ResolvedProjectReference | undefined,
  options: ts.CompilerOptions,
): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations {
  const referenceName = typeof reference === "string" ? reference : reference.fileName;
  const cacheKey = `${containingFile}\0${referenceName}`;
  const cachedResolution = state.typeReferenceResolutions.get(cacheKey);
  if (cachedResolution !== undefined) {
    return cachedResolution;
  }
  const resolutionRoots = typeReferenceResolutionRoots(state, referenceName, containingFile);
  const resolution = ts.resolveTypeReferenceDirective(
    referenceName,
    containingFile,
    options,
    createBoundedResolutionHost(state, resolutionRoots),
    redirectedReference,
  );
  const authorizedResolution = authorizeTypeReferenceDirective(
    state,
    referenceName,
    containingFile,
    resolution.resolvedTypeReferenceDirective,
  )
    ? resolution
    : { ...resolution, resolvedTypeReferenceDirective: undefined };
  const resolvedPath = authorizedResolution.resolvedTypeReferenceDirective?.resolvedFileName;
  state.compilerWorkSession.observeResolution({
    allowedRoots: [...resolutionRoots],
    containingFile,
    kind: "type-reference",
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    specifier: referenceName,
  });
  state.typeReferenceResolutions.set(cacheKey, authorizedResolution);
  return authorizedResolution;
}

function typeReferenceResolutionRoots(
  state: CompilerHostState,
  referenceName: string,
  containingFile: string,
): ReadonlySet<string> {
  const roots = alreadyAllowedTypeReferenceRoots(state, referenceName);
  for (const candidate of typeReferencePackageCandidates(referenceName)) {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      candidate,
      candidate,
    );
    if (packageRoots !== undefined) {
      roots.add(packageRoots.canonicalRoot);
      roots.add(packageRoots.logicalRoot);
    }
  }
  return roots;
}

function authorizeTypeReferenceDirective(
  state: CompilerHostState,
  referenceName: string,
  containingFile: string,
  resolution: ts.ResolvedTypeReferenceDirective | undefined,
): boolean {
  if (resolution === undefined) {
    return true;
  }
  return authorizeResolvedTypeReference(state, referenceName, containingFile, resolution);
}

function authorizeResolvedTypeReference(
  state: CompilerHostState,
  referenceName: string,
  containingFile: string,
  resolution: ts.ResolvedTypeReferenceDirective,
): boolean {
  const { resolvedFileName } = resolution;
  if (resolvedFileName === undefined) {
    return true;
  }
  const canonicalResolvedFile = canonicalEvidenceCandidatePath(resolvedFileName);
  if (
    canonicalResolvedFile !== undefined &&
    [...alreadyAllowedTypeReferenceRoots(state, referenceName)].some((root) =>
      isPathWithin(root, canonicalResolvedFile),
    )
  ) {
    return true;
  }
  const packageRoots = visibleTypeReferenceRoots(
    state,
    containingFile,
    referenceName,
    resolvedFileName,
  );
  if (packageRoots === undefined) {
    return false;
  }
  return allowResolvedPackageRoots(state, packageRoots);
}

function alreadyAllowedTypeReferenceRoots(
  state: CompilerHostState,
  referenceName: string,
): Set<string> {
  const packageNames = new Set(typeReferencePackageCandidates(referenceName));
  const observer = createPackageBoundaryObserver(state);
  return new Set(
    [...state.allowedPackageRoots].filter((root) =>
      packageNames.has(readInstalledManifest(root, observer).packageIdentity.name),
    ),
  );
}

function visibleTypeReferenceRoots(
  state: CompilerHostState,
  containingFile: string,
  referenceName: string,
  resolvedFileName: string,
): PackageRootCapability | undefined {
  return typeReferencePackageCandidates(referenceName)
    .map((candidate) =>
      visibleTypeReferenceCandidateRoots(
        state,
        containingFile,
        candidate,
        candidate,
        resolvedFileName,
      ),
    )
    .find((root) => root !== undefined);
}

function typeReferencePackageCandidates(referenceName: string): readonly string[] {
  const declarationProvider = declarationProviderSegments(referenceName).join("/");
  return declarationProvider === referenceName
    ? [referenceName]
    : [referenceName, declarationProvider];
}

function visibleTypeReferenceCandidateRoots(
  state: CompilerHostState,
  containingFile: string,
  declaredPackageName: string,
  physicalPackageName: string,
  resolvedFileName: string,
  expectedPackageIdentity?: string,
): PackageRootCapability | undefined {
  const packageRoots = visibleTypeReferenceCandidatePackageRoots(
    state,
    containingFile,
    declaredPackageName,
    physicalPackageName,
    expectedPackageIdentity,
  );
  return packageRoots !== undefined &&
    declarationEntrypointBelongsToRoot(
      packageRoots.canonicalRoot,
      resolvedFileName,
      createPackageBoundaryObserver(state),
    )
    ? packageRoots
    : undefined;
}

function visibleTypeReferenceCandidatePackageRoots(
  state: CompilerHostState,
  containingFile: string,
  declaredPackageName: string,
  physicalPackageName: string,
  expectedPackageIdentity?: string,
): PackageRootCapability | undefined {
  const packageSegments = parsePackageNameSegments(physicalPackageName);
  if (packageSegments === undefined) {
    return undefined;
  }
  const observer = createPackageBoundaryObserver(state);
  const location = findVisiblePackageForDependency(
    containingFile,
    declaredPackageName,
    packageSegments,
    observer,
  );
  if (location === undefined) {
    return undefined;
  }
  if (
    expectedPackageIdentity !== undefined &&
    readInstalledManifest(location.packageRoot, observer).packageIdentity.name !==
      expectedPackageIdentity
  ) {
    return undefined;
  }
  return {
    canonicalRoot: canonicalPackageBoundary(location.packageRoot, observer),
    logicalRoot: resolve(location.packageRoot),
  };
}

function declarationEntrypointBelongsToRoot(
  packageRoot: string,
  declarationPath: string,
  observer: PackageBoundaryObserver,
): boolean {
  const canonicalDeclarationPath = canonicalPath(declarationPath, observer);
  if (
    canonicalDeclarationPath === undefined ||
    !isPathWithin(packageRoot, canonicalDeclarationPath)
  ) {
    return false;
  }
  const materializedOwner = findMaterializedPackageRoot(canonicalDeclarationPath, observer);
  return materializedOwner === undefined || materializedOwner === packageRoot;
}

function resolveModuleLiteral(
  state: CompilerHostState,
  moduleLiteral: ts.StringLiteralLike,
  containingFile: string,
  redirectedReference: ts.ResolvedProjectReference | undefined,
  options: ts.CompilerOptions,
  containingSourceFile: ts.SourceFile,
): ts.ResolvedModuleWithFailedLookupLocations {
  const mode = ts.getModeForUsageLocation(containingSourceFile, moduleLiteral, options);
  const resolutionRoots = moduleResolutionRoots(state, moduleLiteral.text, containingFile);
  const relativeCandidate = resolve(dirname(containingFile), moduleLiteral.text);
  if (
    !isBarePackageSpecifier(moduleLiteral.text) &&
    !isAuthorizedResolutionPath(resolutionRoots, relativeCandidate)
  ) {
    throw new StaticBoundaryInspectionError(
      "A declaration references source outside its installed package boundary.",
    );
  }
  const resolution = ts.resolveModuleName(
    moduleLiteral.text,
    containingFile,
    options,
    createBoundedResolutionHost(state, resolutionRoots),
    undefined,
    redirectedReference,
    mode,
  );
  // Relative imports cannot authorize another package root.
  const authorizedResolution = authorizeExternalPackage(
    state,
    moduleLiteral.text,
    containingFile,
    resolution.resolvedModule,
  )
    ? resolution
    : { ...resolution, resolvedModule: undefined };
  const resolvedPath = authorizedResolution.resolvedModule?.resolvedFileName;
  state.compilerWorkSession.observeResolution({
    accessStyle: mode === ts.ModuleKind.CommonJS ? "require" : "import",
    allowedRoots: [...resolutionRoots],
    containingFile,
    kind: "module",
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    specifier: moduleLiteral.text,
  });
  return authorizedResolution;
}

function moduleResolutionRoots(
  state: CompilerHostState,
  specifier: string,
  containingFile: string,
): ReadonlySet<string> {
  if (!isBarePackageSpecifier(specifier)) {
    return containingPackageRoots(state, containingFile);
  }
  const roots = new Set<string>();
  for (const { declared, expectedIdentity, physical } of externalPackageCandidates(specifier)) {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declared,
      physical,
      expectedIdentity,
    );
    if (packageRoots !== undefined) {
      roots.add(packageRoots.canonicalRoot);
      roots.add(packageRoots.logicalRoot);
    }
  }
  return roots;
}

function containingPackageRoots(state: CompilerHostState, containingFile: string): Set<string> {
  const canonicalContainingFile = canonicalEvidenceCandidatePath(containingFile);
  return new Set(
    canonicalContainingFile === undefined
      ? []
      : [...state.allowedPackageRoots].filter((root) =>
          isPathWithin(root, canonicalContainingFile),
        ),
  );
}

function authorizeExternalPackage(
  state: CompilerHostState,
  specifier: string,
  containingFile: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
): boolean {
  if (!isResolvedExternalPackage(specifier, resolvedModule)) {
    return true;
  }
  // Every referenced Package Module must be declared by the containing
  // package, including TypeScript's automatic @types fallback, even when a
  // hoisted physical installation happens to resolve.
  const packageRoots = visibleExternalPackageRoots(
    state,
    containingFile,
    specifier,
    resolvedModule.resolvedFileName,
  );
  return allowResolvedPackageRoots(state, packageRoots);
}

function visibleExternalPackageRoots(
  state: CompilerHostState,
  containingFile: string,
  specifier: string,
  resolvedFileName: string,
): PackageRootCapability | undefined {
  return externalPackageCandidates(specifier)
    .map(({ declared, expectedIdentity, physical }) =>
      visibleTypeReferenceCandidateRoots(
        state,
        containingFile,
        declared,
        physical,
        resolvedFileName,
        expectedIdentity,
      ),
    )
    .find((root) => root !== undefined);
}

function externalPackageCandidates(specifier: string): readonly {
  readonly declared: string;
  readonly expectedIdentity: string | undefined;
  readonly physical: string;
}[] {
  const packageSegments = parsePackageNameSegments(specifier);
  if (packageSegments === undefined) {
    return [];
  }
  const packageName = packageSegments.join("/");
  const declarationProvider = declarationProviderSegments(packageName).join("/");
  return [
    { declared: packageName, physical: packageName, expectedIdentity: undefined },
    {
      declared: packageName,
      physical: declarationProvider,
      expectedIdentity: declarationProvider,
    },
    {
      declared: declarationProvider,
      physical: declarationProvider,
      expectedIdentity: undefined,
    },
  ];
}

function allowResolvedPackageRoots(
  state: CompilerHostState,
  packageRoots: PackageRootCapability | undefined,
): boolean {
  if (packageRoots === undefined) {
    return false;
  }
  state.allowedPackageRoots.add(packageRoots.canonicalRoot);
  state.allowedPackageRoots.add(packageRoots.logicalRoot);
  return true;
}

function isResolvedExternalPackage(
  specifier: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
): resolvedModule is ts.ResolvedModuleFull {
  // Windows junctions may not be external; root checks still prove ownership.
  return isBarePackageSpecifier(specifier) && resolvedModule !== undefined;
}

function getBoundedSourceFile(
  state: CompilerHostState,
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  onError?: (message: string) => void,
): ts.SourceFile | undefined {
  if (state.sourceFileCache.has(fileName)) {
    return state.sourceFileCache.get(fileName);
  }
  reserveCompilerHostOperations(state, 2);
  if (!isAuthorizedSourceCandidate(state.allowedPackageRoots, fileName)) {
    throw new StaticBoundaryInspectionError(
      "A declaration references source outside its installed package boundary.",
    );
  }
  const installedSourcePath = resolveReadablePath(fileName, onError);
  if (installedSourcePath === undefined) {
    state.sourceFileCache.set(fileName, undefined);
    return undefined;
  }
  assertAllowedSource(state.allowedPackageRoots, installedSourcePath);
  incrementSourceFileCount(state);

  const sourceText = readSourceText(state, installedSourcePath, onError);
  const sourceFile =
    sourceText === undefined
      ? undefined
      : ts.createSourceFile(fileName, sourceText, languageVersion, true);
  state.sourceFileCache.set(fileName, sourceFile);
  return sourceFile;
}

function isAuthorizedSourceCandidate(allowedRoots: ReadonlySet<string>, fileName: string): boolean {
  return (
    isTypeScriptStandardLibraryDeclaration(fileName) ||
    [...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, resolve(fileName)))
  );
}

function resolveReadablePath(
  fileName: string,
  onError?: (message: string) => void,
): string | undefined {
  try {
    // Canonicalize before containment checks to reject symlink escapes.
    return realpathSync(fileName);
  } catch (error) {
    onError?.(String(error));
    return undefined;
  }
}

function assertAllowedSource(allowedRoots: ReadonlySet<string>, sourcePath: string): void {
  if (
    !isTypeScriptStandardLibraryDeclaration(sourcePath) &&
    ![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, sourcePath))
  ) {
    throw new StaticBoundaryInspectionError(
      "A declaration references source outside its installed package boundary.",
    );
  }
}

function incrementSourceFileCount(state: CompilerHostState): void {
  state.sourceFileCount += 1;
  if (state.sourceFileCount > MAX_SOURCE_FILES) {
    throw new InspectionLimitError(
      "declaration-files",
      "Inspection exceeded its declaration file limit.",
    );
  }
}

function readSourceText(
  state: CompilerHostState,
  sourcePath: string,
  onError?: (message: string) => void,
): string | undefined {
  try {
    const sourceText = readBoundedUtf8File(
      sourcePath,
      INSPECTION_BUDGET_POLICY.declarationSourceBytes - state.sourceByteCount,
      "declaration-bytes",
      "Inspection exceeded its declaration byte limit.",
    );
    state.sourceByteCount += Buffer.byteLength(sourceText);
    state.compilerWorkSession.observeEvidenceFile(sourcePath, sourceText, "declaration");
    return sourceText;
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      throw error;
    }
    onError?.(String(error));
    return undefined;
  }
}

function isBarePackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !isAbsolute(specifier);
}
