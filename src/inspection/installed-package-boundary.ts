import { realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

import { Predicate } from "effect";
import type { Schema } from "effect";

import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  isEvidenceFile,
  isPathWithin,
} from "#typepeek/inspection/evidence-boundary";
import type { ObserveInstalledEvidenceFilePresence } from "#typepeek/inspection/installed-evidence-fingerprint";
import type { PackageIdentity } from "#typepeek/inspection/package-identity";
import { readJsonPackageIdentity } from "#typepeek/inspection/package-identity";

export interface DeclarationProvenance {
  readonly packageIdentity: PackageIdentity;
  readonly file: string;
}

const PACKAGE_RESOLUTION = "package-resolution";

const PACKAGE_RESOLUTION_LIMIT_MESSAGE =
  "Inspection exceeded its package resolution traversal limit.";

const MAX_PACKAGE_SEARCH_DEPTH = 64;

export interface VisiblePackageLocation {
  readonly contextDirectory: string;
  readonly packageRoot: string;
  readonly repositoryRoot: string;
}

export interface InstalledManifest {
  readonly packageIdentity: PackageIdentity;
  readonly exports: Schema.Json | undefined;
}

interface AncestorManifest {
  readonly directory: string;
  readonly manifest: Schema.JsonObject;
}

export interface PackageBoundaryObserver {
  readonly observeEvidenceFilePresence: ObserveInstalledEvidenceFilePresence;
  readonly readManifest: (packageRoot: string) => Schema.JsonObject | undefined;
  readonly reserveOperation: () => void;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export const declarationProviderSegments = function declarationProviderSegments(
  packageRootSpecifier: string
): readonly string[] {
  const segments = packageRootSpecifier.split("/");

  return packageRootSpecifier.startsWith("@")
    ? ["@types", `${segments[0]?.slice(1)}__${segments[1]}`]
    : ["@types", packageRootSpecifier];
};

export const canonicalPath = function canonicalPath(
  fileName: string,
  observer: PackageBoundaryObserver
): string | undefined {
  observer.reserveOperation();

  try {
    return realpathSync.native(fileName);
  } catch {
    return undefined;
  }
};

const isMaterializedPackageRoot = function isMaterializedPackageRoot(
  directory: string
): boolean {
  const parent = nodePath.dirname(directory);
  const grandparent = nodePath.dirname(parent);

  return (
    nodePath.basename(parent) === "node_modules" ||
    (nodePath.basename(grandparent) === "node_modules" &&
      nodePath.basename(parent).startsWith("@"))
  );
};

const hasFile = function hasFile(
  fileName: string,
  observer: PackageBoundaryObserver
): boolean {
  observer.reserveOperation();
  const exists = isEvidenceFile(fileName);
  observer.observeEvidenceFilePresence(fileName, exists);

  return exists;
};

const hasPackageManifest = function hasPackageManifest(
  packageRoot: string,
  observer: PackageBoundaryObserver
): boolean {
  return hasFile(nodePath.join(packageRoot, "package.json"), observer);
};

const packageRootAt = function packageRootAt(
  directory: string,
  observer: PackageBoundaryObserver
): string | undefined {
  if (!isMaterializedPackageRoot(directory)) {
    return undefined;
  }

  return hasPackageManifest(directory, observer)
    ? canonicalPath(directory, observer)
    : undefined;
};

const findMaterializedPackageRootFrom =
  function findMaterializedPackageRootFrom(
    startingDirectory: string,
    observer: PackageBoundaryObserver
  ): string | undefined {
    let directory = startingDirectory;

    for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
      const packageRoot = packageRootAt(directory, observer);

      if (packageRoot !== undefined) {
        return packageRoot;
      }

      const parent = nodePath.dirname(directory);

      if (parent === directory) {
        return undefined;
      }

      directory = parent;
    }

    throw new InspectionLimitError(
      PACKAGE_RESOLUTION,
      PACKAGE_RESOLUTION_LIMIT_MESSAGE
    );
  };

export const findMaterializedPackageRoot = function findMaterializedPackageRoot(
  resolvedFileName: string,
  observer: PackageBoundaryObserver
): string | undefined {
  const resolvedSourcePath = canonicalPath(resolvedFileName, observer);

  if (resolvedSourcePath === undefined) {
    return undefined;
  }

  return findMaterializedPackageRootFrom(
    nodePath.dirname(resolvedSourcePath),
    observer
  );
};

export const assertNoNestedDeclarationOwner =
  function assertNoNestedDeclarationOwner(
    providerRoot: string,
    declarationPath: string,
    observer: PackageBoundaryObserver
  ): void {
    const materializedOwner = findMaterializedPackageRoot(
      declarationPath,
      observer
    );

    if (materializedOwner !== undefined && materializedOwner !== providerRoot) {
      throw new UnsupportedInspectionError(
        "The declaration entrypoint belongs to a nested installed package instead of the selected Declaration Provider."
      );
    }
  };

const invalidPackageIdentity = function invalidPackageIdentity(): never {
  throw new UnsupportedInspectionError(
    "The installed package has no valid Package Identity."
  );
};

const readManifestRecord = function readManifestRecord(
  packageRoot: string,
  observer: PackageBoundaryObserver
): Schema.JsonObject {
  return observer.readManifest(packageRoot) ?? invalidPackageIdentity();
};

export const canonicalPackageBoundary = function canonicalPackageBoundary(
  packageRoot: string,
  observer: PackageBoundaryObserver
): string {
  const canonicalPackageRoot = canonicalPath(packageRoot, observer);

  if (canonicalPackageRoot === undefined) {
    throw new UnsupportedInspectionError(
      "The installed package boundary could not be canonicalized."
    );
  }

  return canonicalPackageRoot;
};

export const assertNoNestedDeclaredEntrypoint =
  function assertNoNestedDeclaredEntrypoint(
    packageRoot: string,
    observer: PackageBoundaryObserver
  ): void {
    const manifest = readManifestRecord(packageRoot, observer);

    const readDeclaredEntrypoint = (): string | undefined => {
      if (Predicate.isString(manifest["types"])) {
        return manifest["types"];
      }

      if (Predicate.isString(manifest["typings"])) {
        return manifest["typings"];
      }

      return undefined;
    };

    const declaredEntrypoint = readDeclaredEntrypoint();

    if (declaredEntrypoint === undefined) {
      return undefined;
    }

    // An exports map selects the active declaration entrypoint and supersedes legacy fields.
    if (manifest["exports"] !== undefined) {
      return undefined;
    }

    const logicalRoot = nodePath.resolve(packageRoot);
    const candidate = nodePath.resolve(logicalRoot, declaredEntrypoint);

    if (isPathWithin(logicalRoot, candidate)) {
      assertNoNestedDeclarationOwner(
        canonicalPackageBoundary(packageRoot, observer),
        candidate,
        observer
      );
    }
  };

export const readInstalledManifest = function readInstalledManifest(
  packageRoot: string,
  observer: PackageBoundaryObserver
): InstalledManifest {
  const manifest = readManifestRecord(packageRoot, observer);
  const packageIdentity = readJsonPackageIdentity(manifest);

  if (packageIdentity === undefined) {
    return invalidPackageIdentity();
  }

  return {
    exports: manifest["exports"],
    packageIdentity,
  };
};

const matchingAncestorManifest = function matchingAncestorManifest(
  directory: string,
  predicate: (directory: string, manifest: Schema.JsonObject) => boolean,
  observer: PackageBoundaryObserver
): AncestorManifest | undefined {
  if (!hasPackageManifest(directory, observer)) {
    return undefined;
  }

  const manifest = readManifestRecord(directory, observer);

  return predicate(directory, manifest) ? { directory, manifest } : undefined;
};

const findAncestorManifest = function findAncestorManifest(
  startingDirectory: string,
  predicate: (directory: string, manifest: Schema.JsonObject) => boolean,
  observer: PackageBoundaryObserver
): AncestorManifest | undefined {
  let directory = startingDirectory;

  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const match = matchingAncestorManifest(directory, predicate, observer);

    if (match !== undefined) {
      return match;
    }

    const parent = nodePath.dirname(directory);

    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }

  throw new InspectionLimitError(
    PACKAGE_RESOLUTION,
    PACKAGE_RESOLUTION_LIMIT_MESSAGE
  );
};

const resolveDeclarationPackageIdentity =
  function resolveDeclarationPackageIdentity(
    declarationPath: string,
    observer: PackageBoundaryObserver
  ): PackageIdentity {
    const owningManifest = findAncestorManifest(
      nodePath.dirname(declarationPath),
      () => true,
      observer
    );

    if (owningManifest !== undefined) {
      return readInstalledManifest(owningManifest.directory, observer)
        .packageIdentity;
    }

    throw new UnsupportedInspectionError(
      "A declaration has no owning Package Identity for provenance."
    );
  };

const declarationPackageIdentityFor = function declarationPackageIdentityFor(
  inspectedPackageRoot: string,
  inspectedPackageIdentity: PackageIdentity,
  declarationPath: string,
  observer: PackageBoundaryObserver
): PackageIdentity {
  // Nested node_modules declarations use their own Package Identity.
  const materializedPackageRoot = findMaterializedPackageRoot(
    declarationPath,
    observer
  );

  if (materializedPackageRoot !== undefined) {
    return materializedPackageRoot === inspectedPackageRoot
      ? inspectedPackageIdentity
      : readInstalledManifest(materializedPackageRoot, observer)
          .packageIdentity;
  }

  // Inner manifests may define module format only; retain the installed package.
  return isPathWithin(inspectedPackageRoot, declarationPath)
    ? inspectedPackageIdentity
    : resolveDeclarationPackageIdentity(declarationPath, observer);
};

export const readDeclarationProvenance = function readDeclarationProvenance(
  repositoryRoot: string,
  packageRoot: string,
  packageIdentity: PackageIdentity,
  declarationPath: string,
  observer: PackageBoundaryObserver
): DeclarationProvenance {
  const declarationPackageIdentity = declarationPackageIdentityFor(
    packageRoot,
    packageIdentity,
    declarationPath,
    observer
  );

  if (!isPathWithin(repositoryRoot, declarationPath)) {
    throw new UnsupportedInspectionError(
      "A declaration has no repository-relative provenance path."
    );
  }

  return {
    file: nodePath
      .relative(repositoryRoot, declarationPath)
      .split(nodePath.sep)
      .join("/"),
    packageIdentity: declarationPackageIdentity,
  };
};

export const isSafePackagePathSegment = function isSafePackagePathSegment(
  segment: string
): boolean {
  return (
    !["", ".", ".."].includes(segment) &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
};

export const parsePackageNameSegments = function parsePackageNameSegments(
  specifier: string
): readonly string[] | undefined {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const packageSegments = segments.slice(0, packageSegmentCount);

  return packageSegments.length === packageSegmentCount &&
    packageSegments.every(isSafePackagePathSegment)
    ? packageSegments
    : undefined;
};

const hasOwnStringProperty = function hasOwnStringProperty(
  value: Schema.Json | undefined,
  property: string
): boolean {
  return (
    Predicate.isReadonlyObject(value) &&
    Object.hasOwn(value, property) &&
    Predicate.isString(value[property])
  );
};

export const hasDeclaredPackage = function hasDeclaredPackage(
  manifest: Schema.JsonObject,
  packageName: string
): boolean {
  return DEPENDENCY_FIELDS.some((field) =>
    hasOwnStringProperty(manifest[field], packageName)
  );
};

const startingDirectory = function startingDirectory(
  resolutionContext: string,
  observer: PackageBoundaryObserver
): string {
  observer.reserveOperation();

  return statSync(resolutionContext).isDirectory()
    ? resolutionContext
    : nodePath.dirname(resolutionContext);
};

const findContextManifest = function findContextManifest(
  contextDirectory: string,
  requirePackageIdentity: boolean,
  observer: PackageBoundaryObserver
): AncestorManifest | undefined {
  return findAncestorManifest(
    contextDirectory,
    (_directory, manifest) =>
      !requirePackageIdentity ||
      readJsonPackageIdentity(manifest) !== undefined,
    observer
  );
};

const isDeclaredFromResolutionContext =
  function isDeclaredFromResolutionContext(
    contextDirectory: string,
    packageName: string,
    requirePackageIdentity: boolean,
    observer: PackageBoundaryObserver
  ): boolean {
    const contextManifest = findContextManifest(
      contextDirectory,
      requirePackageIdentity,
      observer
    );

    return (
      contextManifest !== undefined &&
      hasDeclaredPackage(contextManifest.manifest, packageName)
    );
  };

const hasWorkspaceDeclaration = function hasWorkspaceDeclaration(
  manifest: Schema.JsonObject
): boolean {
  const { workspaces } = manifest;

  return Array.isArray(workspaces) || Predicate.isReadonlyObject(workspaces);
};

const findWorkspaceRoot = function findWorkspaceRoot(
  contextDirectory: string,
  observer: PackageBoundaryObserver
): string | undefined {
  return findAncestorManifest(
    contextDirectory,
    (directory, manifest) =>
      hasWorkspaceDeclaration(manifest) ||
      hasFile(nodePath.join(directory, "pnpm-workspace.yaml"), observer),
    observer
  )?.directory;
};

const visibleRepositoryRoot = function visibleRepositoryRoot(
  contextDirectory: string,
  fallback: string,
  observer: PackageBoundaryObserver
): string {
  return findWorkspaceRoot(contextDirectory, observer) ?? fallback;
};

const hasPlugAndPlayMarker = function hasPlugAndPlayMarker(
  directory: string,
  observer: PackageBoundaryObserver
): boolean {
  return (
    hasFile(nodePath.join(directory, ".pnp.cjs"), observer) ||
    hasFile(nodePath.join(directory, ".pnp.js"), observer)
  );
};

const searchVisiblePackage = function searchVisiblePackage(
  contextDirectory: string,
  packageSegments: readonly string[],
  observer: PackageBoundaryObserver,
  rejectUnsupportedInstallation = true
): VisiblePackageLocation | undefined {
  let directory = contextDirectory;

  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    const candidate = nodePath.join(
      directory,
      "node_modules",
      ...packageSegments
    );

    if (hasPackageManifest(candidate, observer)) {
      return {
        contextDirectory,
        packageRoot: candidate,
        repositoryRoot: visibleRepositoryRoot(
          contextDirectory,
          directory,
          observer
        ),
      };
    }

    if (hasPlugAndPlayMarker(directory, observer)) {
      if (rejectUnsupportedInstallation) {
        throw new UnsupportedInspectionError(
          "The Resolution Context uses an unsupported installation without node_modules."
        );
      }

      return undefined;
    }

    const parent = nodePath.dirname(directory);

    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }

  throw new InspectionLimitError(
    PACKAGE_RESOLUTION,
    PACKAGE_RESOLUTION_LIMIT_MESSAGE
  );
};

export const findVisiblePackage = function findVisiblePackage(
  resolutionContext: string,
  packageSegments: readonly string[],
  observer: PackageBoundaryObserver
): VisiblePackageLocation | undefined {
  const contextDirectory = startingDirectory(resolutionContext, observer);

  if (
    !isDeclaredFromResolutionContext(
      contextDirectory,
      packageSegments.join("/"),
      false,
      observer
    )
  ) {
    return undefined;
  }

  return searchVisiblePackage(contextDirectory, packageSegments, observer);
};

export const findResolvablePackage = function findResolvablePackage(
  resolutionContext: string,
  packageSegments: readonly string[],
  observer: PackageBoundaryObserver
): VisiblePackageLocation | undefined {
  const contextDirectory = startingDirectory(resolutionContext, observer);

  const rejectUnsupportedInstallation = isDeclaredFromResolutionContext(
    contextDirectory,
    packageSegments.join("/"),
    false,
    observer
  );

  return searchVisiblePackage(
    contextDirectory,
    packageSegments,
    observer,
    rejectUnsupportedInstallation
  );
};

export const findResolvableDeclarationProvider =
  function findResolvableDeclarationProvider(
    resolutionContext: string,
    packageSegments: readonly string[],
    observer: PackageBoundaryObserver
  ): VisiblePackageLocation | undefined {
    const contextDirectory = startingDirectory(resolutionContext, observer);

    return searchVisiblePackage(
      contextDirectory,
      packageSegments,
      observer,
      false
    );
  };

export const findVisiblePackageForDependency =
  function findVisiblePackageForDependency(
    resolutionContext: string,
    declaredPackageName: string,
    physicalPackageSegments: readonly string[],
    observer: PackageBoundaryObserver
  ): VisiblePackageLocation | undefined {
    const contextDirectory = startingDirectory(resolutionContext, observer);
    const context = findContextManifest(contextDirectory, true, observer);

    if (context === undefined) {
      return undefined;
    }

    if (
      readJsonPackageIdentity(context.manifest)?.name === declaredPackageName &&
      physicalPackageSegments.join("/") === declaredPackageName &&
      context.manifest["exports"] !== undefined
    ) {
      return {
        contextDirectory,
        packageRoot: context.directory,
        repositoryRoot: visibleRepositoryRoot(
          contextDirectory,
          context.directory,
          observer
        ),
      };
    }

    if (!hasDeclaredPackage(context.manifest, declaredPackageName)) {
      return undefined;
    }

    return searchVisiblePackage(
      contextDirectory,
      physicalPackageSegments,
      observer
    );
  };

export const assertAbsoluteResolutionContext =
  function assertAbsoluteResolutionContext(resolutionContext: string): void {
    if (!nodePath.isAbsolute(resolutionContext)) {
      throw new UnsupportedInspectionError(
        "Resolution Context must be an absolute path."
      );
    }
  };
