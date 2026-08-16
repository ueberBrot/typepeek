import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin, readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
import type { PackageIdentity } from "#typepeek/inspection/protocol";

const MAX_PACKAGE_SEARCH_DEPTH = 64;
const MAX_MANIFEST_BYTES = 256 * 1_024;
export interface VisiblePackageLocation {
  readonly contextDirectory: string;
  readonly packageRoot: string;
  readonly repositoryRoot: string;
}

export interface InstalledManifest {
  readonly packageIdentity: PackageIdentity;
  readonly exports: unknown;
}

interface AncestorManifest {
  readonly directory: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface PackageBoundaryObserver {
  readonly manifestCache: Map<string, Readonly<Record<string, unknown>>> | undefined;
  readonly remainingBytes: () => number | undefined;
  readonly reserveBytes: (count: number) => void;
  readonly reserveOperation: () => void;
}

const UNOBSERVED_BOUNDARY: PackageBoundaryObserver = {
  manifestCache: undefined,
  remainingBytes: () => undefined,
  reserveBytes: () => undefined,
  reserveOperation: () => undefined,
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export function declarationProviderSegments(packageRootSpecifier: string): readonly string[] {
  const segments = packageRootSpecifier.split("/");
  return packageRootSpecifier.startsWith("@")
    ? ["@types", `${segments[0]?.slice(1)}__${segments[1]}`]
    : ["@types", packageRootSpecifier];
}

export function assertNoNestedDeclarationOwner(
  providerRoot: string,
  declarationPath: string,
): void {
  const materializedOwner = findMaterializedPackageRoot(declarationPath);
  if (materializedOwner !== undefined && materializedOwner !== providerRoot) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint belongs to a nested installed package instead of the selected Declaration Provider.",
    );
  }
}

export function readDeclarationProvenance(
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

export function parsePackageNameSegments(specifier: string): readonly string[] | undefined {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const packageSegments = segments.slice(0, packageSegmentCount);
  return packageSegments.length === packageSegmentCount &&
    packageSegments.every(isSafePackagePathSegment)
    ? packageSegments
    : undefined;
}

export function isSafePackagePathSegment(segment: string): boolean {
  return !["", ".", ".."].includes(segment) && !segment.includes("\\") && !segment.includes("\0");
}

export function findVisiblePackage(
  resolutionContext: string,
  packageSegments: readonly string[],
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): VisiblePackageLocation | undefined {
  const contextDirectory = startingDirectory(resolutionContext, observer);
  if (
    !isDeclaredFromResolutionContext(contextDirectory, packageSegments.join("/"), false, observer)
  ) {
    return undefined;
  }
  return searchVisiblePackage(contextDirectory, packageSegments, observer);
}

export function findVisiblePackageForDependency(
  resolutionContext: string,
  declaredPackageName: string,
  physicalPackageSegments: readonly string[],
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): VisiblePackageLocation | undefined {
  const contextDirectory = startingDirectory(resolutionContext, observer);
  if (!isDeclaredFromResolutionContext(contextDirectory, declaredPackageName, true, observer)) {
    return undefined;
  }
  return searchVisiblePackage(contextDirectory, physicalPackageSegments, observer);
}

function searchVisiblePackage(
  contextDirectory: string,
  packageSegments: readonly string[],
  observer: PackageBoundaryObserver,
): VisiblePackageLocation | undefined {
  let directory = contextDirectory;

  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, "node_modules", ...packageSegments);
    if (hasPackageManifest(candidate, observer)) {
      return {
        contextDirectory,
        packageRoot: candidate,
        repositoryRoot: visibleRepositoryRoot(contextDirectory, directory, observer),
      };
    }
    rejectPlugAndPlayInstallation(directory, observer);

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }

  throw new InspectionLimitError(
    "package-resolution",
    "Inspection exceeded its package resolution traversal limit.",
  );
}

function visibleRepositoryRoot(
  contextDirectory: string,
  fallback: string,
  observer: PackageBoundaryObserver,
): string {
  return findWorkspaceRoot(contextDirectory, observer) ?? fallback;
}

function isDeclaredFromResolutionContext(
  contextDirectory: string,
  packageName: string,
  requirePackageIdentity: boolean,
  observer: PackageBoundaryObserver,
): boolean {
  const contextManifest = findContextManifest(contextDirectory, requirePackageIdentity, observer);
  return (
    contextManifest !== undefined &&
    DEPENDENCY_FIELDS.some((field) => hasOwnStringProperty(contextManifest[field], packageName))
  );
}

function findContextManifest(
  contextDirectory: string,
  requirePackageIdentity: boolean,
  observer: PackageBoundaryObserver,
): Readonly<Record<string, unknown>> | undefined {
  return findAncestorManifest(
    contextDirectory,
    (_directory, manifest) =>
      !requirePackageIdentity || readPackageIdentity(manifest) !== undefined,
    observer,
  )?.manifest;
}

function findWorkspaceRoot(
  contextDirectory: string,
  observer: PackageBoundaryObserver,
): string | undefined {
  return findAncestorManifest(
    contextDirectory,
    (directory, manifest) =>
      hasWorkspaceDeclaration(manifest) ||
      hasFile(join(directory, "pnpm-workspace.yaml"), observer),
    observer,
  )?.directory;
}

function findAncestorManifest(
  startingDirectory: string,
  predicate: (directory: string, manifest: Readonly<Record<string, unknown>>) => boolean,
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): AncestorManifest | undefined {
  let directory = startingDirectory;
  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const match = matchingAncestorManifest(directory, predicate, observer);
    if (match !== undefined) {
      return match;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  throw new InspectionLimitError(
    "package-resolution",
    "Inspection exceeded its package resolution traversal limit.",
  );
}

function matchingAncestorManifest(
  directory: string,
  predicate: (directory: string, manifest: Readonly<Record<string, unknown>>) => boolean,
  observer: PackageBoundaryObserver,
): AncestorManifest | undefined {
  if (!hasPackageManifest(directory, observer)) {
    return undefined;
  }
  const manifest = readManifestRecord(directory, observer);
  return predicate(directory, manifest) ? { directory, manifest } : undefined;
}

function hasWorkspaceDeclaration(manifest: Readonly<Record<string, unknown>>): boolean {
  const workspaces = manifest["workspaces"];
  return Array.isArray(workspaces) || isRecord(workspaces);
}

function hasOwnStringProperty(value: unknown, property: string): boolean {
  return isRecord(value) && Object.hasOwn(value, property) && typeof value[property] === "string";
}

function rejectPlugAndPlayInstallation(directory: string, observer: PackageBoundaryObserver): void {
  if (hasPlugAndPlayMarker(directory, observer)) {
    throw new UnsupportedInspectionError(
      "The Resolution Context uses an unsupported installation without node_modules.",
    );
  }
}

function hasPlugAndPlayMarker(directory: string, observer: PackageBoundaryObserver): boolean {
  return (
    hasFile(join(directory, ".pnp.cjs"), observer) || hasFile(join(directory, ".pnp.js"), observer)
  );
}

function hasFile(fileName: string, observer: PackageBoundaryObserver): boolean {
  observer.reserveOperation();
  try {
    return statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function startingDirectory(resolutionContext: string, observer: PackageBoundaryObserver): string {
  observer.reserveOperation();
  return statSync(resolutionContext).isDirectory() ? resolutionContext : dirname(resolutionContext);
}

function hasPackageManifest(packageRoot: string, observer: PackageBoundaryObserver): boolean {
  return hasFile(join(packageRoot, "package.json"), observer);
}

export function readInstalledManifest(
  packageRoot: string,
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): InstalledManifest {
  const manifest = readManifestRecord(packageRoot, observer);
  const packageIdentity = readPackageIdentity(manifest);
  if (packageIdentity === undefined) {
    return invalidPackageIdentity();
  }
  return {
    packageIdentity,
    exports: manifest["exports"],
  };
}

function readManifestRecord(
  packageRoot: string,
  observer: PackageBoundaryObserver,
): Readonly<Record<string, unknown>> {
  const manifestPath = join(packageRoot, "package.json");
  const cachedManifest = observer.manifestCache?.get(manifestPath);
  if (cachedManifest !== undefined) {
    return cachedManifest;
  }
  observer.reserveOperation();
  const remainingBytes = observer.remainingBytes();
  const manifestText = readBoundedUtf8File(
    manifestPath,
    remainingBytes === undefined
      ? MAX_MANIFEST_BYTES
      : Math.min(MAX_MANIFEST_BYTES, remainingBytes),
    remainingBytes !== undefined && remainingBytes < MAX_MANIFEST_BYTES
      ? "compiler-host-bytes"
      : "package-manifest-bytes",
    remainingBytes !== undefined && remainingBytes < MAX_MANIFEST_BYTES
      ? "Inspection exceeded its compiler host byte limit."
      : "Inspection exceeded its package manifest size limit.",
  );
  observer.reserveBytes(Buffer.byteLength(manifestText));
  const manifest = parseManifest(manifestText);
  if (!isRecord(manifest)) {
    return invalidPackageIdentity();
  }
  observer.manifestCache?.set(manifestPath, manifest);
  return manifest;
}

function readPackageIdentity(value: unknown): PackageIdentity | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  const version = value["version"];
  if (version !== undefined && typeof version !== "string") {
    return undefined;
  }
  return version === undefined ? { name: value["name"] } : { name: value["name"], version };
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

export function canonicalPackageBoundary(
  packageRoot: string,
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): string {
  const canonicalPackageRoot = canonicalPath(packageRoot, observer);
  if (canonicalPackageRoot === undefined) {
    throw new UnsupportedInspectionError(
      "The installed package boundary could not be canonicalized.",
    );
  }
  return canonicalPackageRoot;
}

export function canonicalPath(
  fileName: string,
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): string | undefined {
  observer.reserveOperation();
  try {
    return realpathSync(fileName);
  } catch {
    return undefined;
  }
}

export function assertAbsoluteResolutionContext(resolutionContext: string): void {
  if (!isAbsolute(resolutionContext)) {
    throw new UnsupportedInspectionError("Resolution Context must be an absolute path.");
  }
}

export function findMaterializedPackageRoot(
  resolvedFileName: string,
  observer: PackageBoundaryObserver = UNOBSERVED_BOUNDARY,
): string | undefined {
  const resolvedSourcePath = canonicalPath(resolvedFileName, observer);
  if (resolvedSourcePath === undefined) {
    return undefined;
  }
  return findMaterializedPackageRootFrom(dirname(resolvedSourcePath), observer);
}

function findMaterializedPackageRootFrom(
  startingDirectory: string,
  observer: PackageBoundaryObserver,
): string | undefined {
  let directory = startingDirectory;
  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const packageRoot = packageRootAt(directory, observer);
    if (packageRoot !== undefined) {
      return packageRoot;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  throw new InspectionLimitError(
    "package-resolution",
    "Inspection exceeded its package resolution traversal limit.",
  );
}

function packageRootAt(directory: string, observer: PackageBoundaryObserver): string | undefined {
  if (!isMaterializedPackageRoot(directory)) {
    return undefined;
  }
  return hasPackageManifest(directory, observer) ? canonicalPath(directory, observer) : undefined;
}

function isMaterializedPackageRoot(directory: string): boolean {
  const parent = dirname(directory);
  const grandparent = dirname(parent);
  return (
    basename(parent) === "node_modules" ||
    (basename(grandparent) === "node_modules" && basename(parent).startsWith("@"))
  );
}
