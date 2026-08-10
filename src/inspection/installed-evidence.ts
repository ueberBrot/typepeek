import ts from "@typescript/typescript6";
import { type } from "arktype";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin, readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
import {
  type NormalizedInspectionTarget,
  type PackageIdentity,
  type PublicSubpath,
} from "#typepeek/inspection/protocol";
import { selectResolutionVariant } from "#typepeek/inspection/resolution-variant";

const MAX_PACKAGE_SEARCH_DEPTH = 64;
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_SOURCE_FILES = 128;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;
const packageIdentitySchema = type({
  name: "string",
  "version?": "string | undefined",
});

/** Bounded analyzer state. Symbols share one program; provenance may use a Declaration Provider. */
export interface InstalledPackageModule {
  readonly checker: ts.TypeChecker;
  readonly moduleSymbol: ts.Symbol;
  readonly packageIdentity: PackageIdentity;
  readonly publicSubpaths: readonly PublicSubpath[];
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

interface VisiblePackageLocation {
  readonly packageRoot: string;
  readonly repositoryRoot: string;
}

interface PackageSpecifier {
  readonly packageSegments: readonly string[];
  readonly packageRootSpecifier: string;
  readonly subpathKey?: string;
}

interface InstalledManifest {
  readonly packageIdentity: PackageIdentity;
  readonly exports: unknown;
}

interface AncestorManifest {
  readonly directory: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * Reads one installed package root or Public Subpath without executing code.
 * Returns `undefined` only when not visible; invalid evidence throws typed failures.
 */
export function readInstalledPackageModule(
  request: NormalizedInspectionTarget,
): InstalledPackageModule | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);
  const packageSpecifier = parsePackageSpecifier(request.specifier);
  if (packageSpecifier === undefined) {
    throw new UnsupportedInspectionError("The requested Specifier is not a Package Module.");
  }

  const packageLocation = findVisiblePackage(
    request.resolutionContext,
    packageSpecifier.packageSegments,
  );
  if (packageLocation === undefined) {
    return undefined;
  }
  const { packageRoot } = packageLocation;

  const manifest = readInstalledManifest(packageRoot);
  const canonicalPackageRoot = canonicalPackageBoundary(packageRoot);
  const resolutionVariant = selectResolutionVariant({
    request,
    packageRoot: canonicalPackageRoot,
    packageRootSpecifier: packageSpecifier.packageRootSpecifier,
    ...(packageSpecifier.subpathKey === undefined
      ? {}
      : { subpathKey: packageSpecifier.subpathKey }),
    exports: manifest.exports,
  });
  const compilerOptions = inspectionCompilerOptions();
  const program = ts.createProgram({
    rootNames: [resolutionVariant.declarationPath],
    options: compilerOptions,
    host: createBoundedCompilerHost(canonicalPackageRoot, compilerOptions),
  });
  const { checker, moduleSymbol } = inspectModuleEvidence(
    program,
    resolutionVariant.declarationPath,
  );
  return {
    checker,
    moduleSymbol,
    packageIdentity: manifest.packageIdentity,
    get publicSubpaths() {
      return resolutionVariant.readPublicSubpaths();
    },
    declarationProvenance: (declarationPath) =>
      readDeclarationProvenance(
        canonicalPackageBoundary(packageLocation.repositoryRoot),
        canonicalPackageRoot,
        manifest.packageIdentity,
        declarationPath,
      ),
  };
}

function readDeclarationProvenance(
  repositoryRoot: string,
  packageRoot: string,
  packageIdentity: PackageIdentity,
  declarationPath: string,
): {
  readonly packageIdentity: PackageIdentity;
  readonly file: string;
} {
  const declarationPackageIdentity = declarationPackageIdentityFor(
    packageRoot,
    packageIdentity,
    declarationPath,
  );
  if (!isPathWithin(repositoryRoot, declarationPath)) {
    throw new UnsupportedInspectionError(
      "A declaration has no repository-relative provenance path.",
    );
  }
  return {
    packageIdentity: declarationPackageIdentity,
    file: relative(repositoryRoot, declarationPath).split(sep).join("/"),
  };
}

function declarationPackageIdentityFor(
  inspectedPackageRoot: string,
  inspectedPackageIdentity: PackageIdentity,
  declarationPath: string,
): PackageIdentity {
  // Nested node_modules declarations use their own Package Identity.
  const materializedPackageRoot = findMaterializedPackageRoot(declarationPath);
  if (materializedPackageRoot !== undefined) {
    return materializedPackageRoot === inspectedPackageRoot
      ? inspectedPackageIdentity
      : readInstalledManifest(materializedPackageRoot).packageIdentity;
  }
  // Inner manifests may define module format only; retain the installed package.
  return isPathWithin(inspectedPackageRoot, declarationPath)
    ? inspectedPackageIdentity
    : resolveDeclarationPackageIdentity(declarationPath);
}

function resolveDeclarationPackageIdentity(declarationPath: string): PackageIdentity {
  const owningManifest = findAncestorManifest(dirname(declarationPath), () => true);
  if (owningManifest !== undefined) {
    return readInstalledManifest(owningManifest.directory).packageIdentity;
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

function parsePackageSpecifier(specifier: string): PackageSpecifier | undefined {
  const packageSegments = parsePackageNameSegments(specifier);
  if (packageSegments === undefined) {
    return undefined;
  }
  const segments = specifier.split("/");
  const subpathSegments = segments.slice(packageSegments.length);
  if (!subpathSegments.every(isSafePackagePathSegment)) {
    return undefined;
  }
  return {
    packageSegments,
    packageRootSpecifier: packageSegments.join("/"),
    ...(subpathSegments.length === 0 ? {} : { subpathKey: `./${subpathSegments.join("/")}` }),
  };
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
  return findVisiblePackage(resolutionContext, packageSegments)?.packageRoot;
}

function findVisiblePackage(
  resolutionContext: string,
  packageSegments: readonly string[],
): VisiblePackageLocation | undefined {
  const contextDirectory = startingDirectory(resolutionContext);
  if (!isDeclaredFromResolutionContext(contextDirectory, packageSegments.join("/"))) {
    return undefined;
  }
  let directory = contextDirectory;

  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, "node_modules", ...packageSegments);
    if (hasPackageManifest(candidate)) {
      return {
        packageRoot: candidate,
        repositoryRoot: findWorkspaceRoot(contextDirectory) ?? directory,
      };
    }
    rejectPlugAndPlayInstallation(directory);

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }

  throw new InspectionLimitError("Inspection exceeded its package resolution traversal limit.");
}

function isDeclaredFromResolutionContext(contextDirectory: string, packageName: string): boolean {
  const contextManifest = findContextManifest(contextDirectory, false);
  return (
    contextManifest !== undefined &&
    DEPENDENCY_FIELDS.some((field) => hasOwnStringProperty(contextManifest[field], packageName))
  );
}

function findContextManifest(
  contextDirectory: string,
  requirePackageIdentity: boolean,
): Readonly<Record<string, unknown>> | undefined {
  return findAncestorManifest(
    contextDirectory,
    (_directory, manifest) =>
      !requirePackageIdentity || readPackageIdentity(manifest) !== undefined,
  )?.manifest;
}

function isDeclaredByContainingPackage(containingFile: string, packageName: string): boolean {
  const packageManifest = findContextManifest(startingDirectory(containingFile), true);
  return (
    packageManifest !== undefined &&
    DEPENDENCY_FIELDS.some((field) => hasOwnStringProperty(packageManifest[field], packageName))
  );
}

function findWorkspaceRoot(contextDirectory: string): string | undefined {
  return findAncestorManifest(
    contextDirectory,
    (directory, manifest) =>
      hasWorkspaceDeclaration(manifest) || hasFile(join(directory, "pnpm-workspace.yaml")),
  )?.directory;
}

function findAncestorManifest(
  startingDirectory: string,
  predicate: (directory: string, manifest: Readonly<Record<string, unknown>>) => boolean,
): AncestorManifest | undefined {
  let directory = startingDirectory;
  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    if (hasPackageManifest(directory)) {
      const manifest = readManifestRecord(directory);
      if (predicate(directory, manifest)) {
        return { directory, manifest };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  throw new InspectionLimitError("Inspection exceeded its package resolution traversal limit.");
}

function hasWorkspaceDeclaration(manifest: Readonly<Record<string, unknown>>): boolean {
  const workspaces = manifest["workspaces"];
  return Array.isArray(workspaces) || isRecord(workspaces);
}

function hasOwnStringProperty(value: unknown, property: string): boolean {
  return isRecord(value) && Object.hasOwn(value, property) && typeof value[property] === "string";
}

function rejectPlugAndPlayInstallation(directory: string): void {
  if (hasPlugAndPlayMarker(directory)) {
    throw new UnsupportedInspectionError(
      "The Resolution Context uses an unsupported installation without node_modules.",
    );
  }
}

function hasPlugAndPlayMarker(directory: string): boolean {
  return hasFile(join(directory, ".pnp.cjs")) || hasFile(join(directory, ".pnp.js"));
}

function hasFile(fileName: string): boolean {
  try {
    return statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function startingDirectory(resolutionContext: string): string {
  return statSync(resolutionContext).isDirectory() ? resolutionContext : dirname(resolutionContext);
}

function hasPackageManifest(packageRoot: string): boolean {
  return hasFile(join(packageRoot, "package.json"));
}

function readInstalledManifest(packageRoot: string): InstalledManifest {
  const manifest = readManifestRecord(packageRoot);
  const packageIdentity = readPackageIdentity(manifest);
  if (packageIdentity === undefined) {
    return invalidPackageIdentity();
  }
  return {
    packageIdentity,
    exports: manifest["exports"],
  };
}

function readManifestRecord(packageRoot: string): Readonly<Record<string, unknown>> {
  const manifestText = readBoundedUtf8File(
    join(packageRoot, "package.json"),
    MAX_MANIFEST_BYTES,
    "Inspection exceeded its package manifest size limit.",
  );
  const manifest = parseManifest(manifestText);
  return isRecord(manifest) ? manifest : invalidPackageIdentity();
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // Reject unresolved re-export graphs before returning a result.
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

  // Bare imports may add compiler-resolved roots to this allowlist.
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
  const packageSegments = parsePackageNameSegments(specifier);
  if (
    packageSegments === undefined ||
    !isDeclaredByContainingPackage(containingFile, packageSegments.join("/"))
  ) {
    return false;
  }

  // Every referenced Package Module must be declared by the containing
  // package, even when a hoisted physical installation happens to resolve.
  const packageRoot =
    findMaterializedPackageRoot(resolvedModule.resolvedFileName) ??
    findReferencedPackageRoot(containingFile, specifier, resolvedModule.resolvedFileName);
  if (packageRoot !== undefined) {
    state.allowedPackageRoots.add(packageRoot);
    return true;
  }
  return false;
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
    // Canonicalize before containment checks to reject symlink escapes.
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
