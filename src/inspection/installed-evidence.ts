import type ts from "@typescript/typescript6";

import type { CompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import {
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import { isPathWithin } from "#typepeek/inspection/evidence-boundary";
import type { InstalledEvidenceObserver } from "#typepeek/inspection/installed-evidence-fingerprint";
import type {
  InstalledManifest,
  PackageBoundaryObserver,
  VisiblePackageLocation,
} from "#typepeek/inspection/installed-package-boundary";
import {
  assertAbsoluteResolutionContext,
  assertNoNestedDeclarationOwner,
  assertNoNestedDeclaredEntrypoint,
  canonicalPackageBoundary,
  declarationProviderSegments,
  findResolvableDeclarationProvider,
  findResolvablePackage,
  findVisiblePackage,
  isSafePackagePathSegment,
  parsePackageNameSegments,
  readDeclarationProvenance,
  readInstalledManifest,
} from "#typepeek/inspection/installed-package-boundary";
import { materializeInstalledProgram } from "#typepeek/inspection/installed-program";
import {
  isKnownNodePlatformSpecifier,
  isNodePlatformSpecifier,
} from "#typepeek/inspection/node-declaration-authority";
import { profileInspectionPhase } from "#typepeek/inspection/performance-profile";
import type {
  InspectionPlanQuery,
  InspectionResultIdentity,
  NormalizedInspectionTarget,
  PackageIdentity,
  PublicSubpath,
} from "#typepeek/inspection/protocol";
import { selectResolutionVariant } from "#typepeek/inspection/resolution-variant";
import type { SupportingTypeScope } from "#typepeek/inspection/supporting-type-policy";

interface SelectedDeclarationPackage {
  readonly root: string;
  readonly logicalRoot: string;
  readonly identity: PackageIdentity;
  readonly repositoryRoot: string;
}

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
  readonly readNodeDeclarationProvider: () =>
    | DeclarationProviderAuthority
    | undefined;
} & (
  | {
      readonly kind: "package";
      readonly ambientSpecifier: string | undefined;
    }
  | {
      readonly kind: "platform";
      readonly specifier: string;
    }
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

const selectVisibleNodeDeclarationProvider =
  function selectVisibleNodeDeclarationProvider(
    request: NormalizedInspectionTarget,
    compilerWorkSession: CompilerWorkSession,
    packageBoundaryObserver: PackageBoundaryObserver
  ): SelectedNodeDeclarationProvider | undefined {
    const location = findVisiblePackage(
      request.resolutionContext,
      ["@types", "node"],
      packageBoundaryObserver
    );

    if (location === undefined) {
      return undefined;
    }

    const manifest = readInstalledManifest(
      location.packageRoot,
      packageBoundaryObserver
    );

    const declarationRoot = canonicalPackageBoundary(
      location.packageRoot,
      packageBoundaryObserver
    );

    const { declarationPath } = selectResolutionVariant({
      compilerWorkSession,
      declarationRoots: [declarationRoot, location.packageRoot],
      exports: manifest.exports,
      missingDeclarationMessage:
        "The visible @types/node package has no readable entrypoint.",
      packageRoot: declarationRoot,
      packageRootSpecifier: "@types/node",
      request: { ...request, specifier: "@types/node" },
    });

    assertNoNestedDeclarationOwner(
      declarationRoot,
      declarationPath,
      packageBoundaryObserver
    );

    return {
      declarationPath,
      location,
      manifest,
      root: { canonical: declarationRoot, logical: location.packageRoot },
    };
  };

const selectNodeDeclarationProvider = function selectNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession
): InspectableModuleSelection {
  if (!isKnownNodePlatformSpecifier(request.specifier)) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${request.specifier}" is not a known Node runtime module.`
    );
  }

  const { packageBoundaryObserver } = compilerWorkSession;

  const provider = selectVisibleNodeDeclarationProvider(
    request,
    compilerWorkSession,
    packageBoundaryObserver
  );

  if (provider === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${request.specifier}" has no visible @types/node Declaration Provider.`
    );
  }

  return {
    compilerWorkSession,
    declarationAuthority: {
      declarationPath: provider.declarationPath,
      root: provider.root,
    },
    kind: "platform",
    packageBoundaryObserver,
    providerIdentity: provider.manifest.packageIdentity,
    readNodeDeclarationProvider: (): undefined => undefined,
    readPublicSubpaths: () => [],
    repositoryRoot: canonicalPackageBoundary(
      provider.location.repositoryRoot,
      packageBoundaryObserver
    ),
    resolutionContextDirectory: canonicalPackageBoundary(
      provider.location.contextDirectory,
      packageBoundaryObserver
    ),
    resultIdentity: { declarationProvider: provider.manifest.packageIdentity },
    specifier: request.specifier,
    supportingTypeScope: { kind: "platform", specifier: request.specifier },
  };
};

const parsePackageSpecifier = function parsePackageSpecifier(
  specifier: string
): PackageSpecifier | undefined {
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
    packageRootSpecifier: packageSegments.join("/"),
    packageSegments,
    ...(subpathSegments.length !== 0 && {
      subpathKey: `./${subpathSegments.join("/")}`,
    }),
  };
};

const availableDeclarationRoots = function availableDeclarationRoots(
  packageRoot: string,
  logicalPackageRoot: string,
  providerLocation: VisiblePackageLocation | undefined,
  packageBoundaryObserver: PackageBoundaryObserver
): readonly string[] {
  return [
    packageRoot,
    logicalPackageRoot,
    ...(providerLocation === undefined
      ? []
      : [
          canonicalPackageBoundary(
            providerLocation.packageRoot,
            packageBoundaryObserver
          ),
          providerLocation.packageRoot,
        ]),
  ];
};

const selectedPublicSubpath = function selectedPublicSubpath(
  packageSpecifier: PackageSpecifier
): {
  readonly subpathKey?: string;
} {
  return packageSpecifier.subpathKey === undefined
    ? {}
    : { subpathKey: packageSpecifier.subpathKey };
};

const selectedDeclarationPackage = function selectedDeclarationPackage(
  declarationPath: string,
  packageRoot: string,
  manifest: InstalledManifest,
  repositoryRoot: string,
  logicalPackageRoot: string,
  providerLocation: VisiblePackageLocation | undefined,
  packageBoundaryObserver: PackageBoundaryObserver
): SelectedDeclarationPackage {
  if (isPathWithin(packageRoot, declarationPath)) {
    assertNoNestedDeclarationOwner(
      packageRoot,
      declarationPath,
      packageBoundaryObserver
    );

    return {
      identity: manifest.packageIdentity,
      logicalRoot: logicalPackageRoot,
      repositoryRoot: canonicalPackageBoundary(
        repositoryRoot,
        packageBoundaryObserver
      ),
      root: packageRoot,
    };
  }

  if (providerLocation !== undefined) {
    const root = canonicalPackageBoundary(
      providerLocation.packageRoot,
      packageBoundaryObserver
    );

    if (isPathWithin(root, declarationPath)) {
      const providerManifest = readInstalledManifest(
        providerLocation.packageRoot,
        packageBoundaryObserver
      );

      assertNoNestedDeclaredEntrypoint(
        providerLocation.packageRoot,
        packageBoundaryObserver
      );
      assertNoNestedDeclarationOwner(
        root,
        declarationPath,
        packageBoundaryObserver
      );

      return {
        identity: providerManifest.packageIdentity,
        logicalRoot: providerLocation.packageRoot,
        repositoryRoot: canonicalPackageBoundary(
          providerLocation.repositoryRoot,
          packageBoundaryObserver
        ),
        root,
      };
    }
  }

  throw new UnsupportedInspectionError(
    "The declaration entrypoint has no installed Declaration Provider."
  );
};

const separateProviderAmbientSpecifier =
  function separateProviderAmbientSpecifier(
    declarationRoot: string,
    packageRoot: string,
    specifier: string
  ): string | undefined {
    return declarationRoot === packageRoot ? undefined : specifier;
  };

const visibleNodeDeclarationProvider = function visibleNodeDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession,
  packageBoundaryObserver: PackageBoundaryObserver
): NodeDeclarationProvider | undefined {
  const provider = selectVisibleNodeDeclarationProvider(
    request,
    compilerWorkSession,
    packageBoundaryObserver
  );

  return provider === undefined
    ? undefined
    : {
        declarationPath: provider.declarationPath,
        root: provider.root,
      };
};

const memoizePublicSubpaths = function memoizePublicSubpaths(
  readPublicSubpaths: () => readonly PublicSubpath[]
): () => readonly PublicSubpath[] {
  let publicSubpaths: readonly PublicSubpath[] | undefined;

  return () => {
    publicSubpaths ??= readPublicSubpaths();

    return publicSubpaths;
  };
};

const packageResultIdentity = function packageResultIdentity(
  packageIdentity: PackageIdentity,
  declarationPackage: {
    readonly root: string;
    readonly identity: PackageIdentity;
  },
  packageRoot: string
): InspectionResultIdentity {
  return declarationPackage.root === packageRoot
    ? { packageIdentity }
    : { declarationProvider: declarationPackage.identity, packageIdentity };
};

const selectPackageDeclarationProvider =
  function selectPackageDeclarationProvider(
    request: NormalizedInspectionTarget,
    compilerWorkSession: CompilerWorkSession
  ): InspectableModuleSelection | undefined {
    const packageSpecifier = parsePackageSpecifier(request.specifier);

    if (packageSpecifier === undefined) {
      throw new StaticBoundaryInspectionError(
        "The requested Specifier is outside the static Inspectable Module boundary."
      );
    }

    const { packageBoundaryObserver } = compilerWorkSession;

    const packageLocation = findResolvablePackage(
      request.resolutionContext,
      packageSpecifier.packageSegments,
      packageBoundaryObserver
    );

    if (packageLocation === undefined) {
      return undefined;
    }

    const manifest = readInstalledManifest(
      packageLocation.packageRoot,
      packageBoundaryObserver
    );

    const canonicalPackageRoot = canonicalPackageBoundary(
      packageLocation.packageRoot,
      packageBoundaryObserver
    );

    const providerLocation = findResolvableDeclarationProvider(
      request.resolutionContext,
      declarationProviderSegments(packageSpecifier.packageRootSpecifier),
      packageBoundaryObserver
    );

    const resolutionVariant = selectResolutionVariant({
      compilerWorkSession,
      declarationRoots: availableDeclarationRoots(
        canonicalPackageRoot,
        packageLocation.packageRoot,
        providerLocation,
        packageBoundaryObserver
      ),
      missingDeclarationMessage: `Package Module "${request.specifier}" has no readable Declaration Provider.`,
      packageRoot: canonicalPackageRoot,
      packageRootSpecifier: packageSpecifier.packageRootSpecifier,
      request,
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
      packageBoundaryObserver
    );

    return {
      ambientSpecifier: separateProviderAmbientSpecifier(
        declarationPackage.root,
        canonicalPackageRoot,
        request.specifier
      ),
      compilerWorkSession,
      declarationAuthority: {
        declarationPath: resolutionVariant.declarationPath,
        root: {
          canonical: declarationPackage.root,
          logical: declarationPackage.logicalRoot,
        },
      },
      kind: "package",
      packageBoundaryObserver,
      providerIdentity: declarationPackage.identity,
      readNodeDeclarationProvider: () =>
        visibleNodeDeclarationProvider(
          request,
          compilerWorkSession,
          packageBoundaryObserver
        ),
      readPublicSubpaths: memoizePublicSubpaths(
        resolutionVariant.readPublicSubpaths
      ),
      repositoryRoot: declarationPackage.repositoryRoot,
      resolutionContextDirectory: canonicalPackageBoundary(
        packageLocation.contextDirectory,
        packageBoundaryObserver
      ),
      resultIdentity: packageResultIdentity(
        manifest.packageIdentity,
        declarationPackage,
        canonicalPackageRoot
      ),
      supportingTypeScope: { kind: "package" },
    };
  };

const selectDeclarationProvider = function selectDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession
): InspectableModuleSelection | undefined {
  return isNodePlatformSpecifier(request.specifier)
    ? selectNodeDeclarationProvider(request, compilerWorkSession)
    : selectPackageDeclarationProvider(request, compilerWorkSession);
};

/** Selects canonical Installed Evidence without materializing a TypeScript program. */
export const selectInspectableModule = function selectInspectableModule(
  request: NormalizedInspectionTarget,
  evidenceObserver?: InstalledEvidenceObserver
): InspectableModuleSelection | undefined {
  assertAbsoluteResolutionContext(request.resolutionContext);

  return profileInspectionPhase("declaration-provider-selection", () =>
    selectDeclarationProvider(
      request,
      createCompilerWorkSession(
        evidenceObserver === undefined ? {} : { evidenceObserver }
      )
    )
  );
};

const materializeInspectableModule = function materializeInspectableModule(
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[]
): InspectableModuleEvidence {
  const { checker, moduleSymbol } = materializeInstalledProgram(
    selection,
    queries
  );

  return {
    checker,
    declarationProvenance: (declarationPath) =>
      readDeclarationProvenance(
        selection.repositoryRoot,
        selection.declarationAuthority.root.canonical,
        selection.providerIdentity,
        declarationPath,
        selection.packageBoundaryObserver
      ),
    moduleSymbol,
    get publicSubpaths() {
      return selection.readPublicSubpaths();
    },
    resultIdentity: selection.resultIdentity,
    supportingTypeScope: selection.supportingTypeScope,
  };
};

export const materializeInspectableModuleEvidence =
  function materializeInspectableModuleEvidence(
    selection: InspectableModuleSelection,
    queries: readonly InspectionPlanQuery[]
  ): InspectableModuleEvidence {
    return profileInspectionPhase("program-materialization", () =>
      materializeInspectableModule(selection, queries)
    );
  };
