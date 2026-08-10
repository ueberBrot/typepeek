import ts from "@typescript/typescript6";
import { type } from "arktype";
import { realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin, readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
import {
  type NormalizedInspectionTarget,
  type InspectionResultIdentity,
  type PackageIdentity,
  type PublicSubpath,
} from "#typepeek/inspection/protocol";
import { selectResolutionVariant } from "#typepeek/inspection/resolution-variant";
import type { SupportingTypeScope } from "#typepeek/inspection/supporting-type-policy";

const MAX_PACKAGE_SEARCH_DEPTH = 64;
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_SOURCE_FILES = 128;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;
const NODE_PLATFORM_SPECIFIERS = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ),
);
const packageIdentitySchema = type({
  name: "string",
  "version?": "string | undefined",
});

export interface InspectableModuleEvidence {
  readonly checker: ts.TypeChecker;
  readonly moduleSymbol: ts.Symbol;
  readonly resultIdentity: InspectionResultIdentity;
  readonly publicSubpaths: readonly PublicSubpath[];
  readonly supportingTypeScope: SupportingTypeScope;
  readonly declarationProvenance: (declarationPath: string) => {
    readonly packageIdentity: PackageIdentity;
    readonly file: string;
  };
}

interface DeclarationProviderSelectionBase {
  readonly declarationPath: string;
  readonly declarationRoot: string;
  readonly repositoryRoot: string;
  readonly resultIdentity: InspectionResultIdentity;
  readonly readPublicSubpaths: () => readonly PublicSubpath[];
  readonly supportingTypeScope: SupportingTypeScope;
  readonly providerIdentity: PackageIdentity;
}

type DeclarationProviderSelection = DeclarationProviderSelectionBase &
  (
    | { readonly kind: "package"; readonly ambientSpecifier: string | undefined }
    | { readonly kind: "platform"; readonly specifier: string }
  );

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
export function readInspectableModuleEvidence(
  request: NormalizedInspectionTarget,
): InspectableModuleEvidence | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);
  const selection = selectDeclarationProvider(request);
  return selection === undefined ? undefined : materializeInspectableModule(selection);
}

function selectDeclarationProvider(
  request: NormalizedInspectionTarget,
): DeclarationProviderSelection | undefined {
  return isNodePlatformSpecifier(request.specifier)
    ? selectNodeDeclarationProvider(request)
    : selectPackageDeclarationProvider(request);
}

function selectPackageDeclarationProvider(
  request: NormalizedInspectionTarget,
): DeclarationProviderSelection | undefined {
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
  const manifest = readInstalledManifest(packageLocation.packageRoot);
  const canonicalPackageRoot = canonicalPackageBoundary(packageLocation.packageRoot);
  const providerLocation = findVisiblePackage(
    request.resolutionContext,
    declarationProviderSegments(packageSpecifier.packageRootSpecifier),
  );
  const resolutionVariant = selectResolutionVariant({
    request,
    packageRoot: canonicalPackageRoot,
    packageRootSpecifier: packageSpecifier.packageRootSpecifier,
    declarationRoots: availableDeclarationRoots(canonicalPackageRoot, providerLocation),
    missingDeclarationMessage: `Package Module "${request.specifier}" has no readable Declaration Provider.`,
    ...selectedPublicSubpath(packageSpecifier),
    exports: manifest.exports,
  });
  const declarationPackage = selectedDeclarationPackage(
    resolutionVariant.declarationPath,
    canonicalPackageRoot,
    manifest,
    packageLocation.repositoryRoot,
    providerLocation,
  );
  return {
    kind: "package",
    ambientSpecifier: separateProviderAmbientSpecifier(
      declarationPackage.root,
      canonicalPackageRoot,
      request.specifier,
    ),
    declarationPath: resolutionVariant.declarationPath,
    declarationRoot: declarationPackage.root,
    repositoryRoot: declarationPackage.repositoryRoot,
    resultIdentity: packageResultIdentity(
      manifest.packageIdentity,
      declarationPackage,
      canonicalPackageRoot,
    ),
    readPublicSubpaths: resolutionVariant.readPublicSubpaths,
    supportingTypeScope: { kind: "package" },
    providerIdentity: declarationPackage.identity,
  };
}

function selectNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
): DeclarationProviderSelection {
  if (!NODE_PLATFORM_SPECIFIERS.has(request.specifier)) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${request.specifier}" is not a known Node runtime module.`,
    );
  }
  const providerLocation = findVisiblePackage(request.resolutionContext, ["@types", "node"]);
  if (providerLocation === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${request.specifier}" has no visible @types/node Declaration Provider.`,
    );
  }
  const providerManifest = readInstalledManifest(providerLocation.packageRoot);
  const providerRoot = canonicalPackageBoundary(providerLocation.packageRoot);
  const providerRequest: NormalizedInspectionTarget = {
    ...request,
    specifier: "@types/node",
  };
  const resolutionVariant = selectResolutionVariant({
    request: providerRequest,
    packageRoot: providerRoot,
    packageRootSpecifier: "@types/node",
    exports: providerManifest.exports,
    missingDeclarationMessage: "The visible @types/node package has no readable entrypoint.",
  });
  assertNoNestedDeclarationOwner(providerRoot, resolutionVariant.declarationPath);
  return {
    kind: "platform",
    specifier: request.specifier,
    declarationPath: resolutionVariant.declarationPath,
    declarationRoot: providerRoot,
    repositoryRoot: canonicalPackageBoundary(providerLocation.repositoryRoot),
    resultIdentity: { declarationProvider: providerManifest.packageIdentity },
    readPublicSubpaths: () => [],
    supportingTypeScope: { kind: "platform", specifier: request.specifier },
    providerIdentity: providerManifest.packageIdentity,
  };
}

function materializeInspectableModule(
  selection: DeclarationProviderSelection,
): InspectableModuleEvidence {
  const compilerOptions = inspectionCompilerOptions();
  const program = ts.createProgram({
    rootNames: [selection.declarationPath],
    options: compilerOptions,
    host: createBoundedCompilerHost(selection.declarationRoot, compilerOptions),
  });
  const { checker, moduleSymbol } = inspectSelectedModule(program, selection);
  return {
    checker,
    moduleSymbol,
    resultIdentity: selection.resultIdentity,
    get publicSubpaths() {
      return selection.readPublicSubpaths();
    },
    supportingTypeScope: selection.supportingTypeScope,
    declarationProvenance: (declarationPath) =>
      readDeclarationProvenance(
        selection.repositoryRoot,
        selection.declarationRoot,
        selection.providerIdentity,
        declarationPath,
      ),
  };
}

function inspectSelectedModule(
  program: ts.Program,
  selection: DeclarationProviderSelection,
): Pick<InspectableModuleEvidence, "checker" | "moduleSymbol"> {
  if (selection.kind === "package") {
    return inspectModuleEvidence(program, selection.declarationPath, selection.ambientSpecifier);
  }
  return inspectPlatformModuleEvidence(program, selection.declarationPath, selection.specifier);
}

function availableDeclarationRoots(
  packageRoot: string,
  providerLocation: VisiblePackageLocation | undefined,
): readonly string[] {
  return providerLocation === undefined
    ? [packageRoot]
    : [packageRoot, canonicalPackageBoundary(providerLocation.packageRoot)];
}

function selectedPublicSubpath(packageSpecifier: PackageSpecifier): {
  readonly subpathKey?: string;
} {
  return packageSpecifier.subpathKey === undefined
    ? {}
    : { subpathKey: packageSpecifier.subpathKey };
}

function packageResultIdentity(
  packageIdentity: PackageIdentity,
  declarationPackage: { readonly root: string; readonly identity: PackageIdentity },
  packageRoot: string,
): InspectionResultIdentity {
  return declarationPackage.root === packageRoot
    ? { packageIdentity }
    : { packageIdentity, declarationProvider: declarationPackage.identity };
}

function separateProviderAmbientSpecifier(
  declarationRoot: string,
  packageRoot: string,
  specifier: string,
): string | undefined {
  return declarationRoot === packageRoot ? undefined : specifier;
}

function isNodePlatformSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") && specifier.length > "node:".length;
}

function declarationProviderSegments(packageRootSpecifier: string): readonly string[] {
  const segments = packageRootSpecifier.split("/");
  return packageRootSpecifier.startsWith("@")
    ? ["@types", `${segments[0]?.slice(1)}__${segments[1]}`]
    : ["@types", packageRootSpecifier];
}

function selectedDeclarationPackage(
  declarationPath: string,
  packageRoot: string,
  manifest: InstalledManifest,
  repositoryRoot: string,
  providerLocation: VisiblePackageLocation | undefined,
): {
  readonly root: string;
  readonly identity: PackageIdentity;
  readonly repositoryRoot: string;
} {
  if (isPathWithin(packageRoot, declarationPath)) {
    assertNoNestedDeclarationOwner(packageRoot, declarationPath);
    return {
      root: packageRoot,
      identity: manifest.packageIdentity,
      repositoryRoot: canonicalPackageBoundary(repositoryRoot),
    };
  }
  if (providerLocation !== undefined) {
    const root = canonicalPackageBoundary(providerLocation.packageRoot);
    if (isPathWithin(root, declarationPath)) {
      assertNoNestedDeclarationOwner(root, declarationPath);
      return {
        root,
        identity: readInstalledManifest(providerLocation.packageRoot).packageIdentity,
        repositoryRoot: canonicalPackageBoundary(providerLocation.repositoryRoot),
      };
    }
  }
  throw new UnsupportedInspectionError(
    "The declaration entrypoint has no installed Declaration Provider.",
  );
}

function assertNoNestedDeclarationOwner(providerRoot: string, declarationPath: string): void {
  const materializedOwner = findMaterializedPackageRoot(declarationPath);
  if (materializedOwner !== undefined && materializedOwner !== providerRoot) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint belongs to a nested installed package instead of the selected Declaration Provider.",
    );
  }
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
  return searchVisiblePackage(contextDirectory, packageSegments);
}

function searchVisiblePackage(
  contextDirectory: string,
  packageSegments: readonly string[],
): VisiblePackageLocation | undefined {
  let directory = contextDirectory;

  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, "node_modules", ...packageSegments);
    if (hasPackageManifest(candidate)) {
      return {
        packageRoot: candidate,
        repositoryRoot: visibleRepositoryRoot(contextDirectory, directory),
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

function visibleRepositoryRoot(contextDirectory: string, fallback: string): string {
  return findWorkspaceRoot(contextDirectory) ?? fallback;
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
    const match = matchingAncestorManifest(directory, predicate);
    if (match !== undefined) {
      return match;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  throw new InspectionLimitError("Inspection exceeded its package resolution traversal limit.");
}

function matchingAncestorManifest(
  directory: string,
  predicate: (directory: string, manifest: Readonly<Record<string, unknown>>) => boolean,
): AncestorManifest | undefined {
  if (!hasPackageManifest(directory)) {
    return undefined;
  }
  const manifest = readManifestRecord(directory);
  return predicate(directory, manifest) ? { directory, manifest } : undefined;
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
  ambientSpecifier: string | undefined,
): Pick<InspectableModuleEvidence, "checker" | "moduleSymbol"> {
  const sourceFile = program.getSourceFile(declarationPath);
  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module.",
    );
  }

  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(program, checker, sourceFile);
  const moduleSymbol = packageModuleSymbol(checker, sourceFile, ambientSpecifier);
  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module.",
    );
  }
  assertResolvedAmbientModuleReExports(program, checker, moduleSymbol);
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
): Pick<InspectableModuleEvidence, "checker" | "moduleSymbol"> {
  const sourceFile = program.getSourceFile(declarationPath);
  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The visible Declaration Provider has no readable module declarations.",
    );
  }
  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(program, checker, sourceFile);
  const moduleSymbol = checker
    .getAmbientModules()
    .find((symbol) => ambientModuleName(symbol) === specifier);
  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${specifier}" is not declared by the visible @types/node provider.`,
    );
  }
  assertResolvedAmbientModuleReExports(program, checker, moduleSymbol);
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
): void {
  const pendingDeclarations = [...(moduleSymbol.declarations ?? [])];
  const visitedDeclarations = new Set<ts.Declaration>();
  for (const declaration of pendingDeclarations) {
    if (visitedDeclarations.has(declaration)) {
      continue;
    }
    visitedDeclarations.add(declaration);
    pendingDeclarations.push(
      ...ambientReExportSpecifiers(declaration).flatMap((specifier) =>
        resolvedModuleDeclarations(checker, specifier),
      ),
      ...referencedDeclarationSourceFiles(program, declaration),
    );
  }
}

function ambientReExportSpecifiers(declaration: ts.Declaration): readonly ts.Expression[] {
  const statements = moduleBodyStatements(declaration);
  return [
    ...statements.flatMap(ambientModuleReferenceSpecifiers),
    ...statements.flatMap(descendantImportTypeSpecifiers),
  ];
}

function descendantImportTypeSpecifiers(root: ts.Node): readonly ts.Expression[] {
  const specifiers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = importTypeSpecifier(node);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
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
): void {
  // Reject unresolved re-export graphs before returning a result.
  const pendingSourceFiles = [entrypoint];
  const visitedSourceFiles = new Set<string>();

  for (const sourceFile of pendingSourceFiles) {
    if (visitedSourceFiles.has(sourceFile.fileName)) {
      continue;
    }
    visitedSourceFiles.add(sourceFile.fileName);
    pendingSourceFiles.push(
      ...reExportedSourceFiles(checker, sourceFile),
      ...referencedDeclarationSourceFiles(program, sourceFile),
    );
  }
}

function referencedDeclarationSourceFiles(
  program: ts.Program,
  declaration: ts.Declaration,
): readonly ts.SourceFile[] {
  if (!ts.isSourceFile(declaration)) {
    return [];
  }
  return [
    ...declaration.referencedFiles.map((reference) =>
      requiredProgramSourceFile(
        program,
        resolve(dirname(declaration.fileName), reference.fileName),
      ),
    ),
    ...declaration.typeReferenceDirectives.map((reference) =>
      resolvedTypeReferenceSourceFile(program, declaration, reference.fileName),
    ),
  ];
}

function resolvedTypeReferenceSourceFile(
  program: ts.Program,
  containingFile: ts.SourceFile,
  typeReferenceName: string,
): ts.SourceFile {
  const resolution = ts.resolveTypeReferenceDirective(
    typeReferenceName,
    containingFile.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedTypeReferenceDirective;
  const resolvedFileName = resolution?.resolvedFileName;
  if (resolvedFileName === undefined) {
    throw unresolvedDeclarationReference();
  }
  return requiredProgramSourceFile(program, resolvedFileName);
}

function requiredProgramSourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const canonicalFileName = canonicalPath(fileName);
  const sourceFile = program
    .getSourceFiles()
    .find((candidate) => canonicalPath(candidate.fileName) === canonicalFileName);
  if (canonicalFileName === undefined || sourceFile === undefined) {
    throw unresolvedDeclarationReference();
  }
  return sourceFile;
}

function unresolvedDeclarationReference(): UnsupportedInspectionError {
  return new UnsupportedInspectionError(
    "A declaration re-export could not be resolved from Installed Evidence.",
  );
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

function resolveTypeReferenceDirectiveReference(
  state: CompilerHostState,
  reference: ts.FileReference | string,
  containingFile: string,
  redirectedReference: ts.ResolvedProjectReference | undefined,
  options: ts.CompilerOptions,
): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations {
  const referenceName = typeof reference === "string" ? reference : reference.fileName;
  const resolution = ts.resolveTypeReferenceDirective(
    referenceName,
    containingFile,
    options,
    state.defaultHost,
    redirectedReference,
  );
  return authorizeTypeReferenceDirective(
    state,
    referenceName,
    containingFile,
    resolution.resolvedTypeReferenceDirective,
  )
    ? resolution
    : { ...resolution, resolvedTypeReferenceDirective: undefined };
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
  const packageRoot = visibleTypeReferenceRoot(containingFile, referenceName, resolvedFileName);
  if (packageRoot === undefined) {
    return false;
  }
  return allowResolvedPackageRoot(state, packageRoot);
}

function visibleTypeReferenceRoot(
  containingFile: string,
  referenceName: string,
  resolvedFileName: string,
): string | undefined {
  return typeReferencePackageCandidates(referenceName)
    .map((candidate) =>
      visibleTypeReferenceCandidateRoot(containingFile, candidate, resolvedFileName),
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
  containingFile: string,
  candidate: string,
  resolvedFileName: string,
): string | undefined {
  const packageSegments = parsePackageNameSegments(candidate);
  if (packageSegments === undefined) {
    return undefined;
  }
  const location = findVisiblePackage(containingFile, packageSegments);
  if (location === undefined) {
    return undefined;
  }
  const packageRoot = canonicalPackageBoundary(location.packageRoot);
  return declarationEntrypointBelongsToRoot(packageRoot, resolvedFileName)
    ? packageRoot
    : undefined;
}

function declarationEntrypointBelongsToRoot(packageRoot: string, declarationPath: string): boolean {
  const canonicalDeclarationPath = canonicalPath(declarationPath);
  if (
    canonicalDeclarationPath === undefined ||
    !isPathWithin(packageRoot, canonicalDeclarationPath)
  ) {
    return false;
  }
  const materializedOwner = findMaterializedPackageRoot(canonicalDeclarationPath);
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
  if (packageSegments === undefined) {
    return false;
  }
  if (!isDeclaredByContainingPackage(containingFile, packageSegments.join("/"))) {
    return false;
  }

  // Every referenced Package Module must be declared by the containing
  // package, even when a hoisted physical installation happens to resolve.
  return allowResolvedPackageRoot(
    state,
    resolvedExternalPackageRoot(containingFile, specifier, resolvedModule.resolvedFileName),
  );
}

function resolvedExternalPackageRoot(
  containingFile: string,
  specifier: string,
  resolvedFileName: string,
): string | undefined {
  return (
    findMaterializedPackageRoot(resolvedFileName) ??
    findReferencedPackageRoot(containingFile, specifier, resolvedFileName)
  );
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
