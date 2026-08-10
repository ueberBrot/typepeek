import ts from "@typescript/typescript6";

import {
  type CompilerWorkSession,
  createCompilerWorkSession,
} from "#typepeek/inspection/compiler-work-session";
import {
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import { isPathWithin } from "#typepeek/inspection/evidence-boundary";
import {
  assertAbsoluteResolutionContext,
  assertNoNestedDeclarationOwner,
  canonicalPackageBoundary,
  declarationProviderSegments,
  findVisiblePackage,
  type InstalledManifest,
  isSafePackagePathSegment,
  parsePackageNameSegments,
  readDeclarationProvenance,
  readInstalledManifest,
  type VisiblePackageLocation,
} from "#typepeek/inspection/installed-package-boundary";
import { materializeInstalledProgram } from "#typepeek/inspection/installed-program";
import {
  isKnownNodePlatformSpecifier,
  isNodePlatformSpecifier,
} from "#typepeek/inspection/node-declaration-authority";
import {
  type NormalizedInspectionTarget,
  type InspectionResultIdentity,
  type PackageIdentity,
  type PublicSubpath,
} from "#typepeek/inspection/protocol";
import { selectResolutionVariant } from "#typepeek/inspection/resolution-variant";
import type { SupportingTypeScope } from "#typepeek/inspection/supporting-type-policy";

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
  readonly compilerWorkSession: CompilerWorkSession;
  readonly resolutionContextDirectory: string;
  readonly declarationPath: string;
  readonly declarationRoot: string;
  readonly repositoryRoot: string;
  readonly resultIdentity: InspectionResultIdentity;
  readonly readPublicSubpaths: () => readonly PublicSubpath[];
  readonly supportingTypeScope: SupportingTypeScope;
  readonly providerIdentity: PackageIdentity;
  readonly readNodeDeclarationProvider: () => NodeDeclarationProvider | undefined;
}

interface NodeDeclarationProvider {
  readonly declarationPath: string;
  readonly declarationRoot: string;
}

type DeclarationProviderSelection = DeclarationProviderSelectionBase &
  (
    | { readonly kind: "package"; readonly ambientSpecifier: string | undefined }
    | { readonly kind: "platform"; readonly specifier: string }
  );

interface PackageSpecifier {
  readonly packageSegments: readonly string[];
  readonly packageRootSpecifier: string;
  readonly subpathKey?: string;
}

/**
 * Reads one installed package root or Public Subpath without executing code.
 * Returns `undefined` only when not visible; invalid evidence throws typed failures.
 */
export function readInspectableModuleEvidence(
  request: NormalizedInspectionTarget,
  selectedExportName?: string,
): InspectableModuleEvidence | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);
  const selection = selectDeclarationProvider(request, createCompilerWorkSession());
  return selection === undefined
    ? undefined
    : materializeInspectableModule(selection, selectedExportName);
}

function selectDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): DeclarationProviderSelection | undefined {
  return isNodePlatformSpecifier(request.specifier)
    ? selectNodeDeclarationProvider(request, compilerWorkSession)
    : selectPackageDeclarationProvider(request, compilerWorkSession);
}

function selectPackageDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): DeclarationProviderSelection | undefined {
  const packageSpecifier = parsePackageSpecifier(request.specifier);
  if (packageSpecifier === undefined) {
    throw new StaticBoundaryInspectionError(
      "The requested Specifier is outside the static Inspectable Module boundary.",
    );
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
    compilerWorkSession,
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
    compilerWorkSession,
    resolutionContextDirectory: canonicalPackageBoundary(packageLocation.contextDirectory),
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
    readNodeDeclarationProvider: () => visibleNodeDeclarationProvider(request, compilerWorkSession),
  };
}

function visibleNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): NodeDeclarationProvider | undefined {
  const providerLocation = findVisiblePackage(request.resolutionContext, ["@types", "node"]);
  if (providerLocation === undefined) {
    return undefined;
  }
  const providerManifest = readInstalledManifest(providerLocation.packageRoot);
  const declarationRoot = canonicalPackageBoundary(providerLocation.packageRoot);
  const resolutionVariant = selectResolutionVariant({
    compilerWorkSession,
    request: { ...request, specifier: "@types/node" },
    packageRoot: declarationRoot,
    packageRootSpecifier: "@types/node",
    exports: providerManifest.exports,
    missingDeclarationMessage: "The visible @types/node package has no readable entrypoint.",
  });
  assertNoNestedDeclarationOwner(declarationRoot, resolutionVariant.declarationPath);
  return { declarationPath: resolutionVariant.declarationPath, declarationRoot };
}

function selectNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): DeclarationProviderSelection {
  if (!isKnownNodePlatformSpecifier(request.specifier)) {
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
    compilerWorkSession,
    request: providerRequest,
    packageRoot: providerRoot,
    packageRootSpecifier: "@types/node",
    exports: providerManifest.exports,
    missingDeclarationMessage: "The visible @types/node package has no readable entrypoint.",
  });
  assertNoNestedDeclarationOwner(providerRoot, resolutionVariant.declarationPath);
  return {
    kind: "platform",
    compilerWorkSession,
    resolutionContextDirectory: canonicalPackageBoundary(providerLocation.contextDirectory),
    specifier: request.specifier,
    declarationPath: resolutionVariant.declarationPath,
    declarationRoot: providerRoot,
    repositoryRoot: canonicalPackageBoundary(providerLocation.repositoryRoot),
    resultIdentity: { declarationProvider: providerManifest.packageIdentity },
    readPublicSubpaths: () => [],
    supportingTypeScope: { kind: "platform", specifier: request.specifier },
    providerIdentity: providerManifest.packageIdentity,
    readNodeDeclarationProvider: () => undefined,
  };
}

function materializeInspectableModule(
  selection: DeclarationProviderSelection,
  selectedExportName: string | undefined,
): InspectableModuleEvidence {
  const { checker, moduleSymbol } = materializeInstalledProgram(selection, selectedExportName);
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
