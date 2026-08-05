import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { readBoundedUtf8File } from "#typepeek/inspection/bounded-file";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin } from "#typepeek/inspection/paths";

const MAX_PACKAGE_SEARCH_DEPTH = 64;
const MAX_MANIFEST_BYTES = 256 * 1_024;

export interface PackageManifest {
  readonly name: string;
  readonly version?: string;
  readonly types?: string;
  readonly typings?: string;
  readonly exports?: unknown;
}

export function parsePackageRootSpecifier(specifier: string): readonly string[] | undefined {
  const packageSegments = parsePackageNameSegments(specifier);
  const segments = specifier.split("/");
  return packageSegments?.length === segments.length ? packageSegments : undefined;
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

function isSafePackagePathSegment(segment: string): boolean {
  return !["", ".", ".."].includes(segment) && !segment.includes("\\") && !segment.includes("\0");
}

export function findPackageRoot(
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

export function readManifest(packageRoot: string): PackageManifest {
  const manifestText = readBoundedUtf8File(
    join(packageRoot, "package.json"),
    MAX_MANIFEST_BYTES,
    "Inspection exceeded its package manifest size limit.",
  );
  const manifest: unknown = JSON.parse(manifestText);

  if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
    throw new UnsupportedInspectionError("The installed package has no valid Package Identity.");
  }
  return manifest as unknown as PackageManifest;
}

export function resolveDeclarationPath(packageRoot: string, manifest: PackageManifest): string {
  const declarationTarget = selectDeclarationTarget(manifest);
  const declarationPath = resolve(packageRoot, declarationTarget);

  if (!isPathWithin(packageRoot, declarationPath)) {
    throw new UnsupportedInspectionError(
      "The package declaration entrypoint escapes its installed package boundary.",
    );
  }
  if (!isFile(declarationPath)) {
    throw new UnsupportedInspectionError("The package has no readable declaration entrypoint.");
  }
  return declarationPath;
}

function selectDeclarationTarget(manifest: PackageManifest): string {
  const candidates = [manifest.types, manifest.typings, findTypesExport(manifest.exports)];
  return (
    candidates.find((candidate): candidate is string => typeof candidate === "string") ??
    "./index.d.ts"
  );
}

function findTypesExport(exportsField: unknown): string | undefined {
  if (!isRecord(exportsField)) {
    return undefined;
  }
  return findTypesCondition(exportsField["."] ?? exportsField);
}

function findTypesCondition(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const typesCondition = value["types"];
  return typeof typesCondition === "string" ? typesCondition : findTypesCondition(typesCondition);
}

function isFile(fileName: string): boolean {
  try {
    return statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertAbsoluteResolutionContext(resolutionContext: string): void {
  if (!isAbsolute(resolutionContext)) {
    throw new UnsupportedInspectionError("Resolution Context must be an absolute path.");
  }
}
