import ts from "@typescript/typescript6";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { readBoundedUtf8File } from "#typepeek/inspection/bounded-file";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin } from "#typepeek/inspection/paths";
import type {
  AccessStyle,
  NormalizedInterfaceOverviewRequest,
  PackageIdentity,
} from "#typepeek/inspection/protocol";

const MAX_PACKAGE_SEARCH_DEPTH = 64;
const MAX_MANIFEST_BYTES = 256 * 1_024;

interface PackageManifest {
  readonly name: string;
  readonly version?: string;
}

export interface PackageModuleEvidence {
  readonly declarationPath: string;
  readonly packageIdentity: PackageIdentity;
  readonly packageRoot: string;
}

export function resolvePackageModuleEvidence(
  request: NormalizedInterfaceOverviewRequest,
): PackageModuleEvidence | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);
  const packageSegments = parsePackageRootSpecifier(request.specifier);
  if (packageSegments === undefined) {
    throw new UnsupportedInspectionError(
      "The initial Interface Overview supports package-root Specifiers only.",
    );
  }

  const packageRoot = findPackageRoot(request.resolutionContext, packageSegments);
  if (packageRoot === undefined) {
    return undefined;
  }

  const manifest = readManifest(packageRoot);
  return {
    declarationPath: resolveDeclarationPath(
      request.resolutionContext,
      request.specifier,
      packageRoot,
      request.accessStyle,
    ),
    packageIdentity: packageIdentity(manifest),
    packageRoot,
  };
}

export function findReferencedPackageRoot(
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

function readManifest(packageRoot: string): PackageManifest {
  const manifestText = readBoundedUtf8File(
    join(packageRoot, "package.json"),
    MAX_MANIFEST_BYTES,
    "Inspection exceeded its package manifest size limit.",
  );
  return packageManifest(parseManifest(manifestText));
}

function parseManifest(manifestText: string): unknown {
  try {
    return JSON.parse(manifestText);
  } catch {
    return invalidPackageIdentity();
  }
}

function packageManifest(value: unknown): PackageManifest {
  if (!isRecord(value)) {
    return invalidPackageIdentity();
  }

  const name = packageName(value);
  const version = packageVersion(value);
  return version === undefined ? { name } : { name, version };
}

function packageName(manifest: Readonly<Record<string, unknown>>): string {
  const name = manifest["name"];
  return typeof name === "string" ? name : invalidPackageIdentity();
}

function packageVersion(manifest: Readonly<Record<string, unknown>>): string | undefined {
  const version = manifest["version"];
  if (version === undefined) {
    return undefined;
  }
  return typeof version === "string" ? version : invalidPackageIdentity();
}

function invalidPackageIdentity(): never {
  throw new UnsupportedInspectionError("The installed package has no valid Package Identity.");
}

function packageIdentity(manifest: PackageManifest): PackageIdentity {
  return manifest.version === undefined
    ? { name: manifest.name }
    : { name: manifest.name, version: manifest.version };
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAbsoluteResolutionContext(resolutionContext: string): void {
  if (!isAbsolute(resolutionContext)) {
    throw new UnsupportedInspectionError("Resolution Context must be an absolute path.");
  }
}
