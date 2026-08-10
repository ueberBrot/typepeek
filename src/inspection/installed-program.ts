import ts from "@typescript/typescript6";
import { opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import { isPathWithin, readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
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

const MAX_SOURCE_FILES = 384;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;
const MAX_COMPILER_HOST_OPERATIONS = 50_000;
const MAX_COMPILER_RESOLUTION_BYTES = 8 * 1_024 * 1_024;
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
  compilerHostOperations: number;
  resolutionByteCount: number;
  sourceFileCount: number;
  sourceByteCount: number;
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
  readonly declarationPath: string;
  readonly declarationRoot: string;
  readonly resolutionContextDirectory: string;
  readonly readNodeDeclarationProvider: () =>
    | {
        readonly declarationPath: string;
        readonly declarationRoot: string;
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

/** Materializes and validates one bounded TypeScript declaration program. */
export function materializeInstalledProgram(
  selection: InstalledProgramSelection,
  selectedExportName?: string,
): InstalledProgramEvidence {
  const traversal: DeclarationGraphTraversalState = { nodeCount: 0 };
  const compilerOptions = inspectionCompilerOptions();
  const host = createBoundedCompilerHost(
    [selection.declarationRoot],
    selection.resolutionContextDirectory,
    compilerOptions,
  );
  const initialProgram = ts.createProgram({
    rootNames: [selection.declarationPath],
    options: compilerOptions,
    host,
  });
  const initialSourceFile = initialProgram.getSourceFile(selection.declarationPath);
  const initialModuleSymbol =
    selection.kind === "package" && initialSourceFile !== undefined
      ? packageModuleSymbol(
          initialProgram.getTypeChecker(),
          initialSourceFile,
          selection.ambientSpecifier,
        )
      : undefined;
  const nodeProgram =
    selection.kind === "platform" ||
    initialSourceFile === undefined ||
    initialModuleSymbol === undefined
      ? undefined
      : selectNodeDeclarationProgram(
          initialProgram,
          initialModuleSymbol,
          initialSourceFile,
          () => {
            const nodeProvider = selection.readNodeDeclarationProvider();
            if (nodeProvider === undefined) {
              return undefined;
            }
            host.allowPackageRoot(nodeProvider.declarationRoot);
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
          selectedExportName,
        );
  const program = nodeProgram ?? initialProgram;
  return inspectSelectedModule(program, selection, host, traversal);
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

function inspectionCompilerOptions(): ts.CompilerOptions {
  return {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    // Exclude ambient libraries from bounded Interface Overviews.
    noLib: true,
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
      throw new InspectionLimitError("Inspection exceeded its declaration graph traversal limit.");
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
    throw new InspectionLimitError("Inspection exceeded its declaration graph traversal limit.");
  }
}

function resolvedTypeReferenceSourceFile(
  program: ts.Program,
  containingFile: ts.SourceFile,
  typeReferenceName: string,
  host: BoundedCompilerHost,
): ts.SourceFile {
  const resolution = ts.resolveTypeReferenceDirective(
    typeReferenceName,
    containingFile.fileName,
    program.getCompilerOptions(),
    host,
  ).resolvedTypeReferenceDirective;
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
): BoundedCompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const resolutionHostBase: ts.CompilerHost = {
    ...defaultHost,
    getCurrentDirectory: () => resolutionContextDirectory,
  };
  const canonicalPackageRoots = packageRoots.map((packageRoot) => {
    const canonicalPackageRoot = canonicalPath(packageRoot);
    if (canonicalPackageRoot === undefined) {
      throw new UnsupportedInspectionError(
        "The installed package boundary could not be canonicalized.",
      );
    }
    return canonicalPackageRoot;
  });
  if (canonicalPackageRoots.length === 0) {
    throw new UnsupportedInspectionError("The installed package boundary is missing.");
  }
  const state: CompilerHostState = {
    defaultHost: resolutionHostBase,
    allowedPackageRoots: new Set(canonicalPackageRoots),
    typeReferenceResolutions: new Map(),
    packageManifestCache: new Map(),
    fileExistsCache: new Map(),
    readFileCache: new Map(),
    directoryExistsCache: new Map(),
    directoriesCache: new Map(),
    realpathCache: new Map(),
    sourceFileCache: new Map(),
    compilerHostOperations: 0,
    resolutionByteCount: 0,
    sourceFileCount: 0,
    sourceByteCount: 0,
  };
  const resolutionHost = createBoundedResolutionHost(state);
  const packageBoundaryObserver = createPackageBoundaryObserver(state);
  const programSourceFiles = new WeakMap<ts.Program, ReadonlyMap<string, ts.SourceFile>>();

  // Bare imports may add compiler-resolved roots to this allowlist.
  return {
    ...defaultHost,
    allowPackageRoot: (packageRoot) => {
      state.allowedPackageRoots.add(canonicalPackageBoundary(packageRoot, packageBoundaryObserver));
      state.typeReferenceResolutions.clear();
    },
    getCurrentDirectory: () => resolutionContextDirectory,
    findProgramSourceFile: (program, fileName) => {
      reserveCompilerHostOperations(state, 1);
      let sourceFiles = programSourceFiles.get(program);
      if (sourceFiles === undefined) {
        const indexedSourceFiles = new Map<string, ts.SourceFile>();
        for (const sourceFile of program.getSourceFiles()) {
          const canonicalFileName = canonicalPath(sourceFile.fileName, packageBoundaryObserver);
          if (canonicalFileName !== undefined) {
            indexedSourceFiles.set(canonicalFileName, sourceFile);
          }
        }
        sourceFiles = indexedSourceFiles;
        programSourceFiles.set(program, sourceFiles);
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

function createBoundedResolutionHost(state: CompilerHostState): ts.ModuleResolutionHost {
  const { defaultHost } = state;
  return {
    fileExists: (fileName) =>
      cachedCompilerHostResult(state, state.fileExistsCache, fileName, () =>
        defaultHost.fileExists(fileName),
      ),
    readFile: (fileName) =>
      cachedCompilerHostResult(state, state.readFileCache, fileName, () => {
        try {
          const contents = readBoundedUtf8File(
            fileName,
            MAX_COMPILER_RESOLUTION_BYTES - state.resolutionByteCount,
            "Inspection exceeded its compiler host byte limit.",
          );
          reserveCompilerResolutionBytes(state, Buffer.byteLength(contents));
          return contents;
        } catch (error) {
          if (error instanceof InspectionLimitError) {
            throw error;
          }
          return undefined;
        }
      }),
    ...(defaultHost.directoryExists === undefined
      ? {}
      : {
          directoryExists: (directoryName: string) =>
            cachedCompilerHostResult(
              state,
              state.directoryExistsCache,
              directoryName,
              () => defaultHost.directoryExists?.(directoryName) ?? false,
            ),
        }),
    ...(defaultHost.getDirectories === undefined
      ? {}
      : {
          getDirectories: (directoryName: string) =>
            cachedCompilerHostResult(state, state.directoriesCache, directoryName, () => {
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
            }),
        }),
    ...(defaultHost.realpath === undefined
      ? {}
      : {
          realpath: (path: string) =>
            cachedCompilerHostResult(
              state,
              state.realpathCache,
              path,
              () => defaultHost.realpath?.(path) ?? path,
            ),
        }),
    getCurrentDirectory: () => defaultHost.getCurrentDirectory(),
    useCaseSensitiveFileNames: defaultHost.useCaseSensitiveFileNames(),
  };
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
  state.compilerHostOperations += count;
  if (state.compilerHostOperations > MAX_COMPILER_HOST_OPERATIONS) {
    throw new InspectionLimitError("Inspection exceeded its compiler host work limit.");
  }
}

function reserveCompilerResolutionBytes(state: CompilerHostState, count: number): void {
  state.resolutionByteCount += count;
  if (state.resolutionByteCount > MAX_COMPILER_RESOLUTION_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its compiler host byte limit.");
  }
}

function createPackageBoundaryObserver(state: CompilerHostState): PackageBoundaryObserver {
  return {
    manifestCache: state.packageManifestCache,
    remainingBytes: () => MAX_COMPILER_RESOLUTION_BYTES - state.resolutionByteCount,
    reserveBytes: (count) => reserveCompilerResolutionBytes(state, count),
    reserveOperation: () => reserveCompilerHostOperations(state, 1),
  };
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
  const resolution = ts.resolveTypeReferenceDirective(
    referenceName,
    containingFile,
    options,
    createBoundedResolutionHost(state),
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
  state.typeReferenceResolutions.set(cacheKey, authorizedResolution);
  return authorizedResolution;
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
  const packageRoot = visibleTypeReferenceRoot(
    state,
    containingFile,
    referenceName,
    resolvedFileName,
  );
  if (packageRoot === undefined) {
    return false;
  }
  return allowResolvedPackageRoot(state, packageRoot);
}

function visibleTypeReferenceRoot(
  state: CompilerHostState,
  containingFile: string,
  referenceName: string,
  resolvedFileName: string,
): string | undefined {
  return typeReferencePackageCandidates(referenceName)
    .map((candidate) =>
      visibleTypeReferenceCandidateRoot(
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

function visibleTypeReferenceCandidateRoot(
  state: CompilerHostState,
  containingFile: string,
  declaredPackageName: string,
  physicalPackageName: string,
  resolvedFileName: string,
  expectedPackageIdentity?: string,
): string | undefined {
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
  const packageRoot = canonicalPackageBoundary(location.packageRoot, observer);
  return declarationEntrypointBelongsToRoot(packageRoot, resolvedFileName, observer)
    ? packageRoot
    : undefined;
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
  const resolution = ts.resolveModuleName(
    moduleLiteral.text,
    containingFile,
    options,
    createBoundedResolutionHost(state),
    undefined,
    redirectedReference,
    ts.getModeForUsageLocation(containingSourceFile, moduleLiteral, options),
  );
  // Relative imports cannot authorize another package root.
  return authorizeExternalPackage(
    state,
    moduleLiteral.text,
    containingFile,
    resolution.resolvedModule,
  )
    ? resolution
    : { ...resolution, resolvedModule: undefined };
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
  const packageRoot = visibleExternalPackageRoot(
    state,
    containingFile,
    specifier,
    resolvedModule.resolvedFileName,
  );
  return allowResolvedPackageRoot(state, packageRoot);
}

function visibleExternalPackageRoot(
  state: CompilerHostState,
  containingFile: string,
  specifier: string,
  resolvedFileName: string,
): string | undefined {
  const packageSegments = parsePackageNameSegments(specifier);
  if (packageSegments === undefined) {
    return undefined;
  }
  const packageName = packageSegments.join("/");
  const declarationProvider = declarationProviderSegments(packageName).join("/");
  const candidates = [
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
  return candidates
    .map(({ declared, expectedIdentity, physical }) =>
      visibleTypeReferenceCandidateRoot(
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

function allowResolvedPackageRoot(
  state: CompilerHostState,
  packageRoot: string | undefined,
): boolean {
  if (packageRoot === undefined) {
    return false;
  }
  state.allowedPackageRoots.add(packageRoot);
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
  if (![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, sourcePath))) {
    throw new StaticBoundaryInspectionError(
      "A declaration references source outside its installed package boundary.",
    );
  }
}

function incrementSourceFileCount(state: CompilerHostState): void {
  state.sourceFileCount += 1;
  if (state.sourceFileCount > MAX_SOURCE_FILES) {
    throw new InspectionLimitError("Inspection exceeded its declaration file limit.");
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
      MAX_SOURCE_BYTES - state.sourceByteCount,
      "Inspection exceeded its declaration byte limit.",
    );
    state.sourceByteCount += Buffer.byteLength(sourceText);
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
