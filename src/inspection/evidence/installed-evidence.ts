import type { Checker, Symbol as CompilerSymbol } from "tsrs/async";

import type { CompilerSessionOwner } from "#typepeek/inspection/compiler/compiler-session-owner";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { materializeInstalledProgram } from "#typepeek/inspection/compiler/installed-program";
import { isPathWithin } from "#typepeek/inspection/evidence/evidence-boundary";
import type { InstalledEvidenceObserver } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import type {
  InstalledManifest,
  PackageBoundaryObserver,
  VisiblePackageLocation,
} from "#typepeek/inspection/evidence/installed-package-boundary";
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
} from "#typepeek/inspection/evidence/installed-package-boundary";
import { selectResolutionVariant } from "#typepeek/inspection/evidence/resolution-variant";
import { profileInspectionPhase } from "#typepeek/inspection/execution/performance-profile";
import {
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type {
  InspectionPlanQuery,
  InspectionResultIdentity,
  NormalizedInspectionTarget,
  PackageIdentity,
  PublicSubpath,
} from "#typepeek/inspection/model/protocol";
import {
  isKnownNodePlatformSpecifier,
  isNodePlatformSpecifier,
} from "#typepeek/inspection/projection/declaration-reference-authority";
import type { SupportingTypeScope } from "#typepeek/inspection/projection/supporting-type-policy";

interface SelectedDeclarationPackage {
  readonly root: string;
  readonly logicalRoot: string;
  readonly identity: PackageIdentity;
  readonly repositoryRoot: string;
}

export interface InspectableModuleEvidence {
  readonly checker: Checker;
  readonly moduleSymbol: CompilerSymbol;
  readonly resultIdentity: InspectionResultIdentity;
  readonly publicSubpaths: Promise<readonly PublicSubpath[]>;
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
  readonly readPublicSubpaths: () => Promise<readonly PublicSubpath[]>;
  readonly supportingTypeScope: SupportingTypeScope;
  readonly providerIdentity: PackageIdentity;
  readonly packageBoundaryObserver: PackageBoundaryObserver;
  readonly readNodeDeclarationProvider: () => Promise<
    DeclarationProviderAuthority | undefined
  >;
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
  async function selectVisibleNodeDeclarationProvider(
    request: NormalizedInspectionTarget,
    compilerWorkSession: CompilerWorkSession,
    packageBoundaryObserver: PackageBoundaryObserver
  ): Promise<SelectedNodeDeclarationProvider | undefined> {
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

    const { declarationPath } = await selectResolutionVariant({
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

const selectNodeDeclarationProvider =
  async function selectNodeDeclarationProvider(
    request: NormalizedInspectionTarget,
    compilerWorkSession: CompilerWorkSession
  ): Promise<InspectableModuleSelection> {
    if (!isKnownNodePlatformSpecifier(request.specifier)) {
      throw new UnsupportedInspectionError(
        `Node Platform Module "${request.specifier}" is not a known Node runtime module.`
      );
    }

    const { packageBoundaryObserver } = compilerWorkSession;

    const provider = await selectVisibleNodeDeclarationProvider(
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
      readNodeDeclarationProvider: async (): Promise<undefined> => {
        await Promise.resolve(undefined);
      },
      readPublicSubpaths: async () => await Promise.resolve([]),
      repositoryRoot: canonicalPackageBoundary(
        provider.location.repositoryRoot,
        packageBoundaryObserver
      ),
      resolutionContextDirectory: canonicalPackageBoundary(
        provider.location.contextDirectory,
        packageBoundaryObserver
      ),
      resultIdentity: {
        declarationProvider: provider.manifest.packageIdentity,
      },
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

const visibleNodeDeclarationProvider =
  async function visibleNodeDeclarationProvider(
    request: NormalizedInspectionTarget,
    compilerWorkSession: CompilerWorkSession,
    packageBoundaryObserver: PackageBoundaryObserver
  ): Promise<NodeDeclarationProvider | undefined> {
    const provider = await selectVisibleNodeDeclarationProvider(
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
  readPublicSubpaths: () => Promise<readonly PublicSubpath[]>
): () => Promise<readonly PublicSubpath[]> {
  let publicSubpaths: Promise<readonly PublicSubpath[]> | undefined;

  return async () => {
    publicSubpaths ??= readPublicSubpaths();

    return await publicSubpaths;
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
  async function selectPackageDeclarationProvider(
    request: NormalizedInspectionTarget,
    compilerWorkSession: CompilerWorkSession
  ): Promise<InspectableModuleSelection | undefined> {
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

    const resolutionVariant = await selectResolutionVariant({
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
      readNodeDeclarationProvider: async () =>
        await visibleNodeDeclarationProvider(
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

const selectDeclarationProvider = async function selectDeclarationProvider(
  request: NormalizedInspectionTarget,
  compilerWorkSession: CompilerWorkSession
): Promise<InspectableModuleSelection | undefined> {
  return isNodePlatformSpecifier(request.specifier)
    ? await selectNodeDeclarationProvider(request, compilerWorkSession)
    : await selectPackageDeclarationProvider(request, compilerWorkSession);
};

/** Selects canonical Installed Evidence without materializing a TypeScript program. */
export const selectInspectableModule = async function selectInspectableModule(
  request: NormalizedInspectionTarget,
  evidenceObserver?: InstalledEvidenceObserver,
  owner?: CompilerSessionOwner
): Promise<InspectableModuleSelection | undefined> {
  assertAbsoluteResolutionContext(request.resolutionContext);

  return await profileInspectionPhase(
    "declaration-provider-selection",
    async () =>
      await selectDeclarationProvider(
        request,
        createCompilerWorkSession({
          ...(evidenceObserver !== undefined && { evidenceObserver }),
          ...(owner !== undefined && { owner }),
        })
      )
  );
};

const materializeInspectableModule =
  async function materializeInspectableModule(
    selection: InspectableModuleSelection,
    queries: readonly InspectionPlanQuery[]
  ): Promise<InspectableModuleEvidence> {
    const { checker, moduleSymbol } = await materializeInstalledProgram(
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
  async function materializeInspectableModuleEvidence(
    selection: InspectableModuleSelection,
    queries: readonly InspectionPlanQuery[]
  ): Promise<InspectableModuleEvidence> {
    return await profileInspectionPhase(
      "program-materialization",
      async () => await materializeInspectableModule(selection, queries)
    );
  };
