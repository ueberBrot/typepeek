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
import type { InstalledEvidenceObserver } from "#typepeek/inspection/installed-evidence-fingerprint";
import {
  assertAbsoluteResolutionContext,
  assertNoNestedDeclaredEntrypoint,
  assertNoNestedDeclarationOwner,
  canonicalPackageBoundary,
  declarationProviderSegments,
  findVisiblePackage,
  type InstalledManifest,
  type PackageBoundaryObserver,
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
import { profileInspectionPhase } from "#typepeek/inspection/performance-profile";
import type {
  InspectionResultIdentity,
  InspectionPlanQuery,
  NormalizedInspectionTarget,
  PackageIdentity,
  PublicSubpath,
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

export interface InspectableModuleDiscoveryEvidence {
  readonly resultIdentity: InspectionResultIdentity;
  readonly publicSubpaths: readonly PublicSubpath[];
}

/** Couples a declaration entrypoint to its canonical and logical authorization roots. */
export interface DeclarationProviderAuthority {
  readonly declarationPath: string;
  readonly root: {
    readonly canonical: string;
    readonly logical: string;
  };
}

export type InspectableModuleSelection = {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly resolutionContextDirectory: string;
  readonly declarationAuthority: DeclarationProviderAuthority;
  readonly repositoryRoot: string;
  readonly resultIdentity: InspectionResultIdentity;
  readonly readPublicSubpaths: () => readonly PublicSubpath[];
  readonly supportingTypeScope: SupportingTypeScope;
  readonly providerIdentity: PackageIdentity;
  readonly packageBoundaryObserver: PackageBoundaryObserver;
  readonly readNodeDeclarationProvider: () => DeclarationProviderAuthority | undefined;
} & (
  | { readonly kind: "package"; readonly ambientSpecifier: string | undefined }
  | { readonly kind: "platform"; readonly specifier: string }
);

type NodeDeclarationProvider = DeclarationProviderAuthority;

interface SelectedNodeDeclarationProvider extends NodeDeclarationProvider {
  readonly location: VisiblePackageLocation;
  readonly manifest: InstalledManifest;
}

interface PackageSpecifier {
  readonly packageSegments: readonly string[];
  readonly packageRootSpecifier: string;
  readonly subpathKey?: string;
}

/** Selects canonical Installed Evidence without materializing a TypeScript program. */
export function selectInspectableModule(
  request: NormalizedInspectionTarget,
  evidenceObserver?: InstalledEvidenceObserver,
): InspectableModuleSelection | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);
  return profileInspectionPhase("declaration-provider-selection", () =>
    selectDeclarationProvider(
      request,
      createCompilerWorkSession(evidenceObserver === undefined ? {} : { evidenceObserver }),
    ),
  );
}

/** Materializes declaration evidence for one previously selected module. */
export function materializeInspectableModuleEvidence(
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[],
): InspectableModuleEvidence {
  return profileInspectionPhase("program-materialization", () =>
    materializeInspectableModule(selection, queries),
  );
}

/** Reads manifest-only evidence from one previously selected module. */
export function inspectableModuleDiscoveryEvidence(
  selection: InspectableModuleSelection,
): InspectableModuleDiscoveryEvidence {
  return {
    resultIdentity: selection.resultIdentity,
    get publicSubpaths() {
      return selection.readPublicSubpaths();
    },
  };
}

function selectDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): InspectableModuleSelection | undefined {
  return isNodePlatformSpecifier(request.specifier)
    ? selectNodeDeclarationProvider(request, compilerWorkSession)
    : selectPackageDeclarationProvider(request, compilerWorkSession);
}

function selectPackageDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): InspectableModuleSelection | undefined {
  const packageSpecifier = parsePackageSpecifier(request.specifier);
  if (packageSpecifier === undefined) {
    throw new StaticBoundaryInspectionError(
      "The requested Specifier is outside the static Inspectable Module boundary.",
    );
  }

  const { packageBoundaryObserver } = compilerWorkSession;
  const packageLocation = findVisiblePackage(
    request.resolutionContext,
    packageSpecifier.packageSegments,
    packageBoundaryObserver,
  );
  if (packageLocation === undefined) {
    return undefined;
  }
  const manifest = readInstalledManifest(packageLocation.packageRoot, packageBoundaryObserver);
  const canonicalPackageRoot = canonicalPackageBoundary(
    packageLocation.packageRoot,
    packageBoundaryObserver,
  );
  const providerLocation = findVisiblePackage(
    request.resolutionContext,
    declarationProviderSegments(packageSpecifier.packageRootSpecifier),
    packageBoundaryObserver,
  );
  const resolutionVariant = selectResolutionVariant({
    compilerWorkSession,
    request,
    packageRoot: canonicalPackageRoot,
    packageRootSpecifier: packageSpecifier.packageRootSpecifier,
    declarationRoots: availableDeclarationRoots(
      canonicalPackageRoot,
      packageLocation.packageRoot,
      providerLocation,
      packageBoundaryObserver,
    ),
    missingDeclarationMessage: `Package Module "${request.specifier}" has no readable Declaration Provider.`,
    ...selectedPublicSubpath(packageSpecifier),
    exports: manifest.exports,
  });
  const declarationPackage = selectedDeclarationPackage(
    resolutionVariant.declarationPath,
    canonicalPackageRoot,
    manifest,
    packageLocation.repositoryRoot,
    packageLocation.packageRoot,
    providerLocation,
    packageBoundaryObserver,
  );
  return {
    kind: "package",
    compilerWorkSession,
    resolutionContextDirectory: canonicalPackageBoundary(
      packageLocation.contextDirectory,
      packageBoundaryObserver,
    ),
    ambientSpecifier: separateProviderAmbientSpecifier(
      declarationPackage.root,
      canonicalPackageRoot,
      request.specifier,
    ),
    declarationAuthority: {
      declarationPath: resolutionVariant.declarationPath,
      root: {
        canonical: declarationPackage.root,
        logical: declarationPackage.logicalRoot,
      },
    },
    repositoryRoot: declarationPackage.repositoryRoot,
    resultIdentity: packageResultIdentity(
      manifest.packageIdentity,
      declarationPackage,
      canonicalPackageRoot,
    ),
    readPublicSubpaths: memoizePublicSubpaths(resolutionVariant.readPublicSubpaths),
    supportingTypeScope: { kind: "package" },
    providerIdentity: declarationPackage.identity,
    packageBoundaryObserver,
    readNodeDeclarationProvider: () =>
      visibleNodeDeclarationProvider(request, compilerWorkSession, packageBoundaryObserver),
  };
}

function memoizePublicSubpaths(
  readPublicSubpaths: () => readonly PublicSubpath[],
): () => readonly PublicSubpath[] {
  let publicSubpaths: readonly PublicSubpath[] | undefined;
  return () => {
    publicSubpaths ??= readPublicSubpaths();
    return publicSubpaths;
  };
}

function visibleNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
  packageBoundaryObserver: PackageBoundaryObserver,
): NodeDeclarationProvider | undefined {
  const provider = selectVisibleNodeDeclarationProvider(
    request,
    compilerWorkSession,
    packageBoundaryObserver,
  );
  return provider === undefined
    ? undefined
    : {
        declarationPath: provider.declarationPath,
        root: provider.root,
      };
}

function selectNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
): InspectableModuleSelection {
  if (!isKnownNodePlatformSpecifier(request.specifier)) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${request.specifier}" is not a known Node runtime module.`,
    );
  }
  const { packageBoundaryObserver } = compilerWorkSession;
  const provider = selectVisibleNodeDeclarationProvider(
    request,
    compilerWorkSession,
    packageBoundaryObserver,
  );
  if (provider === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${request.specifier}" has no visible @types/node Declaration Provider.`,
    );
  }
  return {
    kind: "platform",
    compilerWorkSession,
    resolutionContextDirectory: canonicalPackageBoundary(
      provider.location.contextDirectory,
      packageBoundaryObserver,
    ),
    specifier: request.specifier,
    declarationAuthority: {
      declarationPath: provider.declarationPath,
      root: provider.root,
    },
    repositoryRoot: canonicalPackageBoundary(
      provider.location.repositoryRoot,
      packageBoundaryObserver,
    ),
    resultIdentity: { declarationProvider: provider.manifest.packageIdentity },
    readPublicSubpaths: () => [],
    supportingTypeScope: { kind: "platform", specifier: request.specifier },
    providerIdentity: provider.manifest.packageIdentity,
    packageBoundaryObserver,
    readNodeDeclarationProvider: () => undefined,
  };
}

function selectVisibleNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
  packageBoundaryObserver: PackageBoundaryObserver,
): SelectedNodeDeclarationProvider | undefined {
  const location = findVisiblePackage(
    request.resolutionContext,
    ["@types", "node"],
    packageBoundaryObserver,
  );
  if (location === undefined) {
    return undefined;
  }
  const manifest = readInstalledManifest(location.packageRoot, packageBoundaryObserver);
  const declarationRoot = canonicalPackageBoundary(location.packageRoot, packageBoundaryObserver);
  const { declarationPath } = selectResolutionVariant({
    compilerWorkSession,
    request: { ...request, specifier: "@types/node" },
    packageRoot: declarationRoot,
    packageRootSpecifier: "@types/node",
    declarationRoots: [declarationRoot, location.packageRoot],
    exports: manifest.exports,
    missingDeclarationMessage: "The visible @types/node package has no readable entrypoint.",
  });
  assertNoNestedDeclarationOwner(declarationRoot, declarationPath);
  return {
    declarationPath,
    root: { canonical: declarationRoot, logical: location.packageRoot },
    location,
    manifest,
  };
}

function materializeInspectableModule(
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[],
): InspectableModuleEvidence {
  const { checker, moduleSymbol } = materializeInstalledProgram(selection, queries);
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
        selection.declarationAuthority.root.canonical,
        selection.providerIdentity,
        declarationPath,
        selection.packageBoundaryObserver,
      ),
  };
}

function availableDeclarationRoots(
  packageRoot: string,
  logicalPackageRoot: string,
  providerLocation: VisiblePackageLocation | undefined,
  packageBoundaryObserver: PackageBoundaryObserver,
): readonly string[] {
  return [
    packageRoot,
    logicalPackageRoot,
    ...(providerLocation === undefined
      ? []
      : [
          canonicalPackageBoundary(providerLocation.packageRoot, packageBoundaryObserver),
          providerLocation.packageRoot,
        ]),
  ];
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
  logicalPackageRoot: string,
  providerLocation: VisiblePackageLocation | undefined,
  packageBoundaryObserver: PackageBoundaryObserver,
): {
  readonly root: string;
  readonly logicalRoot: string;
  readonly identity: PackageIdentity;
  readonly repositoryRoot: string;
} {
  if (isPathWithin(packageRoot, declarationPath)) {
    assertNoNestedDeclarationOwner(packageRoot, declarationPath);
    return {
      root: packageRoot,
      logicalRoot: logicalPackageRoot,
      identity: manifest.packageIdentity,
      repositoryRoot: canonicalPackageBoundary(repositoryRoot, packageBoundaryObserver),
    };
  }
  if (providerLocation !== undefined) {
    const root = canonicalPackageBoundary(providerLocation.packageRoot, packageBoundaryObserver);
    if (isPathWithin(root, declarationPath)) {
      const providerManifest = readInstalledManifest(
        providerLocation.packageRoot,
        packageBoundaryObserver,
      );
      assertNoNestedDeclaredEntrypoint(providerLocation.packageRoot, packageBoundaryObserver);
      assertNoNestedDeclarationOwner(root, declarationPath, packageBoundaryObserver);
      return {
        root,
        logicalRoot: providerLocation.packageRoot,
        identity: providerManifest.packageIdentity,
        repositoryRoot: canonicalPackageBoundary(
          providerLocation.repositoryRoot,
          packageBoundaryObserver,
        ),
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
