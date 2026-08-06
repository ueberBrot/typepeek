import ts from "@typescript/typescript6";
import { type } from "arktype";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  type AccessStyle,
  type NormalizedInspectionTarget,
  type PackageIdentity,
} from "#typepeek/inspection/protocol";

const MAX_PACKAGE_SEARCH_DEPTH = 64;
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_SOURCE_FILES = 128;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;
const packageIdentitySchema = type({
  name: "string",
  "version?": "string | undefined",
});

/**
 * Analyzer state and provenance derived from one bounded Installed Evidence
 * read. `checker` and `moduleSymbol` always belong to the same compiler program;
 * declaration provenance may resolve to a referenced Declaration Provider.
 */
export interface InstalledPackageModule {
  readonly checker: ts.TypeChecker;
  readonly moduleSymbol: ts.Symbol;
  readonly packageIdentity: PackageIdentity;
  readonly declarationProvenance: (declarationPath: string) => {
    readonly packageIdentity: PackageIdentity;
    readonly file: string;
  };
}

interface CompilerHostState {
  readonly defaultHost: ts.CompilerHost;
  readonly allowedPackageRoots: Set<string>;
  sourceFileCount: number;
  sourceByteCount: number;
}

interface DeclarationOwner {
  readonly packageIdentity: PackageIdentity;
  readonly packageRoot: string;
}

/**
 * Resolves and reads one installed package-root Specifier without executing
 * package or project code. Returns `undefined` only when the package is not
 * visible; expected invalid evidence and exhausted budgets use typed errors.
 */
export function readInstalledPackageModule(
  request: NormalizedInspectionTarget,
): InstalledPackageModule | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);
  const packageSegments = parsePackageRootSpecifier(request.specifier);
  if (packageSegments === undefined) {
    throw new UnsupportedInspectionError(
      "The initial inspection supports package-root Specifiers only.",
    );
  }

  const packageRoot = findPackageRoot(request.resolutionContext, packageSegments);
  if (packageRoot === undefined) {
    return undefined;
  }

  const packageIdentity = readManifest(packageRoot);
  const canonicalPackageRoot = canonicalPackageBoundary(packageRoot);
  const declarationPath = resolveDeclarationPath(
    request.resolutionContext,
    request.specifier,
    canonicalPackageRoot,
    request.accessStyle,
  );
  const compilerOptions = inspectionCompilerOptions();
  const program = ts.createProgram({
    rootNames: [declarationPath],
    options: compilerOptions,
    host: createBoundedCompilerHost(canonicalPackageRoot, compilerOptions),
  });
  const { checker, moduleSymbol } = inspectModuleEvidence(program, declarationPath);
  return {
    checker,
    moduleSymbol,
    packageIdentity,
    declarationProvenance: (declarationPath) =>
      readDeclarationProvenance(canonicalPackageRoot, packageIdentity, declarationPath),
  };
}

function readDeclarationProvenance(
  packageRoot: string,
  packageIdentity: PackageIdentity,
  declarationPath: string,
): {
  readonly packageIdentity: PackageIdentity;
  readonly file: string;
} {
  // Supporting declarations can belong to another installed package, such as a
  // Declaration Provider, so provenance follows the declaration's owning manifest.
  const owner = isPathWithin(packageRoot, declarationPath)
    ? { packageIdentity, packageRoot }
    : resolveDeclarationOwner(declarationPath);
  return {
    packageIdentity: owner.packageIdentity,
    file: relative(owner.packageRoot, declarationPath).split(sep).join("/"),
  };
}

function resolveDeclarationOwner(declarationPath: string): DeclarationOwner {
  let directory = dirname(declarationPath);
  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    if (hasPackageManifest(directory)) {
      return {
        packageIdentity: readManifest(directory),
        packageRoot: canonicalPackageBoundary(directory),
      };
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new UnsupportedInspectionError(
    "A declaration has no owning Package Identity for provenance.",
  );
}

function findReferencedPackageRoot(
  containingFile: string,
  specifier: string,
  resolvedFileName: string,
): string | undefined {
  const packageSegments = parsePackageNameSegments(specifier);
  if (packageSegments === undefined) {
    return undefined;
  }

  const linkedPackageRoot = findPackageRoot(containingFile, packageSegments);
  if (linkedPackageRoot === undefined) {
    return undefined;
  }

  return canonicalContainedPackageRoot(linkedPackageRoot, resolvedFileName);
}

function canonicalContainedPackageRoot(
  linkedPackageRoot: string,
  resolvedFileName: string,
): string | undefined {
  const packageRoot = canonicalPath(linkedPackageRoot);
  const resolvedSourcePath = canonicalPath(resolvedFileName);
  if (packageRoot === undefined || resolvedSourcePath === undefined) {
    return undefined;
  }
  return isPathWithin(packageRoot, resolvedSourcePath) ? packageRoot : undefined;
}

function parsePackageRootSpecifier(specifier: string): readonly string[] | undefined {
  const packageSegments = parsePackageNameSegments(specifier);
  const segments = specifier.split("/");
  return packageSegments?.length === segments.length ? packageSegments : undefined;
}

function parsePackageNameSegments(specifier: string): readonly string[] | undefined {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const packageSegments = segments.slice(0, packageSegmentCount);
  return packageSegments.length === packageSegmentCount &&
    packageSegments.every(isSafePackagePathSegment)
    ? packageSegments
    : undefined;
}

function isSafePackagePathSegment(segment: string): boolean {
  return !["", ".", ".."].includes(segment) && !segment.includes("\\") && !segment.includes("\0");
}

function findPackageRoot(
  resolutionContext: string,
  packageSegments: readonly string[],
): string | undefined {
  let directory = startingDirectory(resolutionContext);

  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, "node_modules", ...packageSegments);
    if (hasPackageManifest(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }

  throw new InspectionLimitError("Inspection exceeded its package resolution traversal limit.");
}

function startingDirectory(resolutionContext: string): string {
  return statSync(resolutionContext).isDirectory() ? resolutionContext : dirname(resolutionContext);
}

function hasPackageManifest(packageRoot: string): boolean {
  try {
    return statSync(join(packageRoot, "package.json")).isFile();
  } catch {
    return false;
  }
}

function readManifest(packageRoot: string): PackageIdentity {
  const manifestText = readBoundedUtf8File(
    join(packageRoot, "package.json"),
    MAX_MANIFEST_BYTES,
    "Inspection exceeded its package manifest size limit.",
  );
  const identity = readPackageIdentity(parseManifest(manifestText));
  return identity ?? invalidPackageIdentity();
}

function readPackageIdentity(value: unknown): PackageIdentity | undefined {
  const identity = packageIdentitySchema(value);
  if (identity instanceof type.errors) {
    return undefined;
  }
  return identity.version === undefined
    ? { name: identity.name }
    : { name: identity.name, version: identity.version };
}

function parseManifest(manifestText: string): unknown {
  try {
    return JSON.parse(manifestText);
  } catch {
    return invalidPackageIdentity();
  }
}

function invalidPackageIdentity(): never {
  throw new UnsupportedInspectionError("The installed package has no valid Package Identity.");
}

function resolveDeclarationPath(
  resolutionContext: string,
  specifier: string,
  packageRoot: string,
  accessStyle: AccessStyle,
): string {
  const declarationPath = resolvePackageDeclaration(resolutionContext, specifier, accessStyle);

  if (declarationPath === undefined) {
    throw new UnsupportedInspectionError("The package has no readable declaration entrypoint.");
  }

  const canonicalPackageRoot = canonicalPackageBoundary(packageRoot);
  const canonicalDeclarationPath = canonicalDeclaration(declarationPath);
  if (!isPathWithin(canonicalPackageRoot, canonicalDeclarationPath)) {
    throw new UnsupportedInspectionError(
      "The package declaration entrypoint escapes its installed package boundary.",
    );
  }
  return canonicalDeclarationPath;
}

function canonicalPackageBoundary(packageRoot: string): string {
  const canonicalPackageRoot = canonicalPath(packageRoot);
  if (canonicalPackageRoot === undefined) {
    throw new UnsupportedInspectionError(
      "The installed package boundary could not be canonicalized.",
    );
  }
  return canonicalPackageRoot;
}

function canonicalDeclaration(declarationPath: string): string {
  const canonicalDeclarationPath = canonicalPath(declarationPath);
  if (canonicalDeclarationPath === undefined) {
    throw new UnsupportedInspectionError("The package has no readable declaration entrypoint.");
  }
  return canonicalDeclarationPath;
}

function resolvePackageDeclaration(
  resolutionContext: string,
  specifier: string,
  accessStyle: AccessStyle,
): string | undefined {
  const contextDirectory = startingDirectory(resolutionContext);
  const containingFile = join(
    contextDirectory,
    accessStyle === "import" ? "__typepeek_resolution__.mts" : "__typepeek_resolution__.cts",
  );
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
  };
  const resolutionMode = accessStyle === "import" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    createBoundedModuleResolutionHost(contextDirectory),
    undefined,
    undefined,
    resolutionMode,
  );
  return isDeclarationResolution(resolution.resolvedModule)
    ? resolution.resolvedModule.resolvedFileName
    : undefined;
}

function createBoundedModuleResolutionHost(contextDirectory: string): ts.ModuleResolutionHost {
  return {
    directoryExists: isDirectory,
    fileExists: isFile,
    getCurrentDirectory: () => contextDirectory,
    readFile: readPackageResolutionFile,
    realpath: (fileName) => canonicalPath(fileName) ?? fileName,
  };
}

function readPackageResolutionFile(fileName: string): string | undefined {
  try {
    return readBoundedUtf8File(
      fileName,
      MAX_MANIFEST_BYTES,
      "Inspection exceeded its package manifest size limit.",
    );
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      throw error;
    }
    return undefined;
  }
}

function isDeclarationResolution(
  resolvedModule: ts.ResolvedModuleFull | undefined,
): resolvedModule is ts.ResolvedModuleFull {
  return resolvedModule !== undefined && isDeclarationExtension(resolvedModule.extension);
}

function isDeclarationExtension(extension: string): boolean {
  return (
    extension === ts.Extension.Dts ||
    extension === ts.Extension.Dmts ||
    extension === ts.Extension.Dcts
  );
}

function isFile(fileName: string): boolean {
  try {
    return statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function canonicalPath(fileName: string): string | undefined {
  try {
    return realpathSync(fileName);
  } catch {
    return undefined;
  }
}

function assertAbsoluteResolutionContext(resolutionContext: string): void {
  if (!isAbsolute(resolutionContext)) {
    throw new UnsupportedInspectionError("Resolution Context must be an absolute path.");
  }
}

function inspectionCompilerOptions(): ts.CompilerOptions {
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

function inspectModuleEvidence(
  program: ts.Program,
  declarationPath: string,
): Pick<InstalledPackageModule, "checker" | "moduleSymbol"> {
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
  // Walking the graph is validation, not indexing: it forces every declaration
  // re-export to resolve before the module can produce an authoritative result.
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

function createBoundedCompilerHost(
  packageRoot: string,
  compilerOptions: ts.CompilerOptions,
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const canonicalPackageRoot = canonicalPath(packageRoot);
  if (canonicalPackageRoot === undefined) {
    throw new UnsupportedInspectionError(
      "The installed package boundary could not be canonicalized.",
    );
  }
  const state: CompilerHostState = {
    defaultHost,
    allowedPackageRoots: new Set([canonicalPackageRoot]),
    sourceFileCount: 0,
    sourceByteCount: 0,
  };

  // Allowed package roots form an authorization set. The host may discover new
  // roots only through compiler-resolved bare package imports.
  return {
    ...defaultHost,
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
    getSourceFile: (fileName, languageVersion, onError) =>
      getBoundedSourceFile(state, fileName, languageVersion, onError),
  };
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
    state.defaultHost,
    undefined,
    redirectedReference,
    ts.getModeForUsageLocation(containingSourceFile, moduleLiteral, options),
  );
  // Only a bare package import resolved by the owned compiler can authorize
  // another Installed Evidence root. Relative paths cannot expand this set.
  authorizeExternalPackage(state, moduleLiteral.text, containingFile, resolution.resolvedModule);
  return resolution;
}

function authorizeExternalPackage(
  state: CompilerHostState,
  specifier: string,
  containingFile: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
): void {
  if (!isResolvedExternalPackage(specifier, resolvedModule)) {
    return;
  }

  const packageRoot =
    // Ordinary packages are recognized from their physical node_modules path;
    // linked workspaces use the visibility-based fallback.
    findMaterializedPackageRoot(resolvedModule.resolvedFileName) ??
    findReferencedPackageRoot(containingFile, specifier, resolvedModule.resolvedFileName);
  if (packageRoot !== undefined) {
    state.allowedPackageRoots.add(packageRoot);
  }
}

function isResolvedExternalPackage(
  specifier: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
): resolvedModule is ts.ResolvedModuleFull {
  // TypeScript may classify workspace packages reached through Windows
  // directory junctions as non-external. The package-root checks below prove
  // that the resolved declaration is Installed Evidence without relying on
  // that platform-sensitive classification.
  return isBarePackageSpecifier(specifier) && resolvedModule !== undefined;
}

function getBoundedSourceFile(
  state: CompilerHostState,
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  onError?: (message: string) => void,
): ts.SourceFile | undefined {
  const installedSourcePath = resolveReadablePath(fileName, onError);
  if (installedSourcePath === undefined) {
    return undefined;
  }
  assertAllowedSource(state.allowedPackageRoots, installedSourcePath);
  incrementSourceFileCount(state);

  const sourceText = readSourceText(state, installedSourcePath, onError);
  return sourceText === undefined
    ? undefined
    : ts.createSourceFile(fileName, sourceText, languageVersion, true);
}

function resolveReadablePath(
  fileName: string,
  onError?: (message: string) => void,
): string | undefined {
  try {
    // Containment is checked against the canonical target so a symlink cannot
    // disguise caller project source as package-owned declarations.
    return realpathSync(fileName);
  } catch (error) {
    onError?.(String(error));
    return undefined;
  }
}

function assertAllowedSource(allowedRoots: ReadonlySet<string>, sourcePath: string): void {
  if (![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, sourcePath))) {
    throw new UnsupportedInspectionError(
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

function findMaterializedPackageRoot(resolvedFileName: string): string | undefined {
  const resolvedSourcePath = canonicalPath(resolvedFileName);
  if (resolvedSourcePath === undefined) {
    return undefined;
  }
  return findMaterializedPackageRootFrom(dirname(resolvedSourcePath));
}

function findMaterializedPackageRootFrom(startingDirectory: string): string | undefined {
  let directory = startingDirectory;
  while (true) {
    const packageRoot = packageRootAt(directory);
    if (packageRoot !== undefined) {
      return packageRoot;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function packageRootAt(directory: string): string | undefined {
  if (!isMaterializedPackageRoot(directory)) {
    return undefined;
  }
  return hasPackageManifest(directory) ? canonicalPath(directory) : undefined;
}

function isMaterializedPackageRoot(directory: string): boolean {
  const parent = dirname(directory);
  const grandparent = dirname(parent);
  return (
    basename(parent) === "node_modules" ||
    (basename(grandparent) === "node_modules" && basename(parent).startsWith("@"))
  );
}

function readBoundedUtf8File(fileName: string, maxBytes: number, limitMessage: string): string {
  const fileDescriptor = openSync(fileName, "r");
  try {
    return readBoundedUtf8(fileDescriptor, maxBytes, limitMessage);
  } finally {
    closeSync(fileDescriptor);
  }
}

function readBoundedUtf8(fileDescriptor: number, maxBytes: number, limitMessage: string): string {
  // The sentinel byte proves that the file exceeds the budget without ever
  // allocating or reading the complete untrusted file.
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let totalBytesRead = 0;

  while (totalBytesRead < buffer.length) {
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }

  if (totalBytesRead > maxBytes) {
    throw new InspectionLimitError(limitMessage);
  }
  return buffer.toString("utf8", 0, totalBytesRead);
}

function isPathWithin(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate);
  const escapesToParent = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  return relativePath === "" || (!escapesToParent && !isAbsolute(relativePath));
}
