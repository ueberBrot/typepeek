import { opendirSync, realpathSync } from "node:fs";
import nodePath from "node:path";

import ts from "@typescript/typescript6";
import { Predicate } from "effect";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import { cachedCompilerLookup } from "#typepeek/inspection/compiler-cache";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  canonicalEvidenceCandidatePath,
  isPathWithin,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence-boundary";
import type { DeclarationProviderAuthority } from "#typepeek/inspection/installed-evidence";
import type { PackageBoundaryObserver } from "#typepeek/inspection/installed-package-boundary";
import {
  canonicalPackageBoundary,
  canonicalPath,
  declarationProviderSegments,
  findMaterializedPackageRoot,
  findVisiblePackageForDependency,
  parsePackageNameSegments,
  readInstalledManifest,
} from "#typepeek/inspection/installed-package-boundary";
import type { NodeProviderProgram } from "#typepeek/inspection/node-declaration-authority";
import { selectNodeDeclarationProgram } from "#typepeek/inspection/node-declaration-authority";
import type { InspectionPlanQuery } from "#typepeek/inspection/protocol";
import {
  INSPECTION_STANDARD_LIBRARY,
  isTypeScriptStandardLibraryDeclaration,
} from "#typepeek/inspection/typescript-standard-library";
import { bitwiseAnd } from "#typepeek/integer-bits";

const rejectCompilerWrite = (): never => {
  throw new UnsupportedInspectionError(
    "Inspection cannot emit compiler output."
  );
};

const FOCUSED_EXPORT = "focused-export";
const COMPLETE_MODULE = "complete-module";

const OUTSIDE_PACKAGE_MESSAGE =
  "A declaration references source outside its installed package boundary.";

const UNRESOLVED_REEXPORT_MESSAGE =
  "A declaration re-export could not be resolved from Installed Evidence.";

const MAX_PACKAGE_LOOKUP_CACHE_ENTRIES = 4096;
const MAX_DECLARATION_GRAPH_DEPTH = 256;

interface CompilerHostState {
  readonly defaultHost: ts.CompilerHost;
  readonly allowedPackageRoots: Set<string>;
  readonly typeReferenceResolutions: Map<
    string,
    ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations
  >;
  readonly fileExistsCache: Map<string, boolean>;
  readonly readFileCache: Map<string, string | undefined>;
  readonly directoryExistsCache: Map<string, boolean>;
  readonly directoriesCache: Map<string, string[]>;
  readonly realpathCache: Map<string, string>;
  readonly sourceFileCache: Map<string, ts.SourceFile | undefined>;
  readonly packageLookups: Map<string, PackageRootCapability | undefined>;
  readonly moduleResolutionCaches: Map<string, ts.ModuleResolutionCache>;
  readonly compilerWorkSession: CompilerWorkSession;
  sourceFileCount: number;
  sourceByteCount: number;
}

interface PackageRootCapability {
  readonly canonicalRoot: string;
  readonly logicalRoot: string;
}

interface BoundedCompilerHost extends ts.CompilerHost {
  readonly allowPackageRoot: (
    packageRoot: DeclarationProviderAuthority["root"]
  ) => void;
  readonly findProgramSourceFile: (
    program: ts.Program,
    fileName: string
  ) => ts.SourceFile | undefined;
  readonly packageBoundaryObserver: PackageBoundaryObserver;
  readonly resolveTypeReferenceDirectiveReferences: NonNullable<
    ts.CompilerHost["resolveTypeReferenceDirectiveReferences"]
  >;
}

interface DeclarationGraphTraversalState {
  nodeCount: number;
}

interface PendingDeclarationGraphEntry {
  readonly declaration: ts.Declaration;
  readonly expandSourceExports: boolean;
}

interface ReExportGraphState {
  readonly pendingEntries: PendingDeclarationGraphEntry[];
  readonly visitedDeclarations: Set<ts.Declaration>;
  readonly visitedExpandedSourceFiles: Set<string>;
  readonly visitedReferenceSourceFiles: Set<string>;
}

export type InstalledProgramSelection = {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly declarationAuthority: DeclarationProviderAuthority;
  readonly resolutionContextDirectory: string;
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

export interface InstalledProgramEvidence {
  readonly checker: ts.TypeChecker;
  readonly moduleSymbol: ts.Symbol;
}

interface InstalledProgramRequirements {
  readonly focusedExportNames: readonly string[];
  readonly needsStandardLibrary: boolean;
  readonly needsNodeAugmentation: boolean;
  readonly nodeAugmentationExportNames: ReadonlySet<string> | undefined;
}

type NodeAugmentationScope = "none" | "complete-module" | "focused-export";

const NODE_AUGMENTATION_SCOPE_BY_QUERY = {
  "declaration-inspection": FOCUSED_EXPORT,
  "export-inspection": FOCUSED_EXPORT,
  "export-search": COMPLETE_MODULE,
  "interface-overview": COMPLETE_MODULE,
  "member-discovery": FOCUSED_EXPORT,
  "member-inspection": FOCUSED_EXPORT,
  "public-subpath-discovery": "none",
  "signature-inspection": FOCUSED_EXPORT,
} as const satisfies Readonly<
  Record<InspectionPlanQuery["intent"], NodeAugmentationScope>
>;

const installedProgramRequirements = function installedProgramRequirements(
  queries: readonly InspectionPlanQuery[]
): InstalledProgramRequirements {
  const focusedExportNames: string[] = [];
  const nodeAugmentationExportNames = new Set<string>();
  let needsNodeAugmentation = false;
  let nodeAugmentationRequiresCompleteModule = false;

  for (const query of queries) {
    if ("exportName" in query) {
      focusedExportNames.push(query.exportName);
    }

    const augmentationScope = NODE_AUGMENTATION_SCOPE_BY_QUERY[query.intent];

    if (augmentationScope === "none") {
      continue;
    }

    needsNodeAugmentation = true;

    if (augmentationScope === COMPLETE_MODULE) {
      nodeAugmentationRequiresCompleteModule = true;
    } else if ("exportName" in query) {
      nodeAugmentationExportNames.add(query.exportName);
    }
  }

  return {
    focusedExportNames,
    needsNodeAugmentation,
    // The checker needs standard declarations to preserve arrays and generic types.
    needsStandardLibrary: queries.some((query) => {
      if (query.intent === "signature-inspection") {
        return true;
      }

      if (query.intent === "export-search" && query.scope === "documentation") {
        return true;
      }

      if (query.intent === "export-inspection") {
        return true;
      }

      if (query.intent === "member-inspection") {
        return true;
      }

      return query.intent === "member-discovery";
    }),
    nodeAugmentationExportNames: nodeAugmentationRequiresCompleteModule
      ? undefined
      : nodeAugmentationExportNames,
  };
};

const inspectionCompilerOptions = function inspectionCompilerOptions(
  includeStandardLibrary = false
): ts.CompilerOptions {
  return {
    ...(includeStandardLibrary
      ? { lib: [INSPECTION_STANDARD_LIBRARY] }
      : { noLib: true }),
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2024,
    types: [],
  };
};

const withoutCompilerDirectoryReader = function withoutCompilerDirectoryReader(
  host: ts.CompilerHost
): Omit<ts.CompilerHost, "readDirectory"> {
  const readOnlyHost = { ...host };
  delete readOnlyHost.readDirectory;

  return readOnlyHost;
};

const isAuthorizedResolutionPath = function isAuthorizedResolutionPath(
  allowedRoots: ReadonlySet<string>,
  candidate: string,
  allowAncestor = false
): boolean {
  const lexicalCandidate = nodePath.resolve(candidate);

  const withinRoot = [...allowedRoots].some((root) =>
    isPathWithin(root, lexicalCandidate)
  );

  if (
    !withinRoot &&
    !(
      allowAncestor &&
      [...allowedRoots].some((root) => isPathWithin(lexicalCandidate, root))
    )
  ) {
    return false;
  }

  // Canonicalize once per probe, including cache hits, so symlink changes are checked.
  const canonicalCandidate = canonicalEvidenceCandidatePath(candidate);

  const canonicalWithinRoot =
    canonicalCandidate !== undefined &&
    [...allowedRoots].some((root) => isPathWithin(root, canonicalCandidate));

  if (withinRoot && !canonicalWithinRoot) {
    throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
  }

  return (
    canonicalWithinRoot ||
    (allowAncestor &&
      canonicalCandidate !== undefined &&
      [...allowedRoots].some((root) => isPathWithin(canonicalCandidate, root)))
  );
};

const reserveCompilerHostOperations = function reserveCompilerHostOperations(
  state: CompilerHostState,
  count: number
): void {
  state.compilerWorkSession.reserveOperations(count);
};

const cachedCompilerHostResult = function cachedCompilerHostResult<Result>(
  state: CompilerHostState,
  cache: Map<string, Result>,
  key: string,
  read: () => Result
): Result {
  reserveCompilerHostOperations(state, 1);

  return cachedCompilerLookup(cache, key, read);
};

const createBoundedResolutionHost = function createBoundedResolutionHost(
  state: CompilerHostState,
  allowedRoots: ReadonlySet<string> = state.allowedPackageRoots
): ts.ModuleResolutionHost {
  const { defaultHost } = state;

  return {
    fileExists: (fileName) =>
      isAuthorizedResolutionPath(allowedRoots, fileName) &&
      cachedCompilerHostResult(state, state.fileExistsCache, fileName, () =>
        defaultHost.fileExists(fileName)
      ),
    readFile: (fileName): string | undefined => {
      if (!isAuthorizedResolutionPath(allowedRoots, fileName)) {
        return undefined;
      }

      return cachedCompilerHostResult(
        state,
        state.readFileCache,
        fileName,
        (): string | undefined => {
          try {
            return state.compilerWorkSession.readResolutionFile(fileName);
          } catch (error) {
            if (error instanceof InspectionLimitError) {
              throw error;
            }

            return undefined;
          }
        }
      );
    },
    ...(defaultHost.directoryExists !== undefined && {
      directoryExists: (directoryName: string) =>
        isAuthorizedResolutionPath(allowedRoots, directoryName, true) &&
        cachedCompilerHostResult(
          state,
          state.directoryExistsCache,
          directoryName,
          () => defaultHost.directoryExists?.(directoryName) ?? false
        ),
    }),
    ...(defaultHost.getDirectories !== undefined && {
      getDirectories: (directoryName: string) => {
        if (!isAuthorizedResolutionPath(allowedRoots, directoryName)) {
          return [];
        }

        return cachedCompilerHostResult(
          state,
          state.directoriesCache,
          directoryName,
          (): string[] => {
            const directories: string[] = [];
            let directory;

            try {
              directory = opendirSync(directoryName);
            } catch {
              return directories;
            }

            try {
              for (
                let entry = directory.readSync();
                entry !== null;
                entry = directory.readSync()
              ) {
                reserveCompilerHostOperations(state, 1);

                if (entry.isDirectory()) {
                  directories.push(nodePath.join(directoryName, entry.name));
                }
              }

              return directories;
            } finally {
              directory.closeSync();
            }
          }
        );
      },
    }),
    ...(defaultHost.realpath !== undefined && {
      realpath: (path: string) =>
        isAuthorizedResolutionPath(allowedRoots, path)
          ? cachedCompilerHostResult(
              state,
              state.realpathCache,
              path,
              () => defaultHost.realpath?.(path) ?? path
            )
          : path,
    }),
    getCurrentDirectory: () => defaultHost.getCurrentDirectory(),
    useCaseSensitiveFileNames: defaultHost.useCaseSensitiveFileNames(),
  };
};

const isAuthorizedSourceCandidate = function isAuthorizedSourceCandidate(
  allowedRoots: ReadonlySet<string>,
  fileName: string
): boolean {
  return (
    isTypeScriptStandardLibraryDeclaration(fileName) ||
    [...allowedRoots].some((allowedRoot) =>
      isPathWithin(allowedRoot, nodePath.resolve(fileName))
    )
  );
};

const isBarePackageSpecifier = function isBarePackageSpecifier(
  specifier: string
): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !nodePath.isAbsolute(specifier)
  );
};

const containingPackageRoots = function containingPackageRoots(
  state: CompilerHostState,
  containingFile: string
): Set<string> {
  const canonicalContainingFile =
    canonicalEvidenceCandidatePath(containingFile);

  return new Set(
    canonicalContainingFile === undefined
      ? []
      : [...state.allowedPackageRoots].filter((root) =>
          isPathWithin(root, canonicalContainingFile)
        )
  );
};

const externalPackageCandidates = function externalPackageCandidates(
  specifier: string
): readonly {
  readonly declared: string;
  readonly expectedIdentity?: string;
  readonly physical: string;
}[] {
  const packageSegments = parsePackageNameSegments(specifier);

  if (packageSegments === undefined) {
    return [];
  }

  const packageName = packageSegments.join("/");

  const declarationProvider =
    declarationProviderSegments(packageName).join("/");

  return [
    {
      declared: packageName,
      physical: packageName,
    },
    {
      declared: packageName,
      expectedIdentity: declarationProvider,
      physical: declarationProvider,
    },
    {
      declared: declarationProvider,
      physical: declarationProvider,
    },
  ];
};

const readVisibleTypeReferenceCandidatePackageRoots =
  function readVisibleTypeReferenceCandidatePackageRoots(
    state: CompilerHostState,
    containingFile: string,
    declaredPackageName: string,
    physicalPackageName: string,
    expectedPackageIdentity: string | undefined
  ): PackageRootCapability | undefined {
    const packageSegments = parsePackageNameSegments(physicalPackageName);

    if (packageSegments === undefined) {
      return undefined;
    }

    const { packageBoundaryObserver: observer } = state.compilerWorkSession;

    const location = findVisiblePackageForDependency(
      containingFile,
      declaredPackageName,
      packageSegments,
      observer
    );

    if (location === undefined) {
      return undefined;
    }

    if (
      expectedPackageIdentity !== undefined &&
      readInstalledManifest(location.packageRoot, observer).packageIdentity
        .name !== expectedPackageIdentity
    ) {
      return undefined;
    }

    return {
      canonicalRoot: canonicalPackageBoundary(location.packageRoot, observer),
      logicalRoot: nodePath.resolve(location.packageRoot),
    };
  };

const visibleTypeReferenceCandidatePackageRoots =
  function visibleTypeReferenceCandidatePackageRoots(
    state: CompilerHostState,
    containingFile: string,
    declaredPackageName: string,
    physicalPackageName: string,
    expectedPackageIdentity?: string
  ): PackageRootCapability | undefined {
    reserveCompilerHostOperations(state, 1);

    // Declarations in one directory share package visibility. Include both names
    // in the key to distinguish package aliases and @types fallbacks.
    const key = JSON.stringify([
      nodePath.dirname(containingFile),
      declaredPackageName,
      physicalPackageName,
      expectedPackageIdentity,
    ]);

    if (state.packageLookups.has(key)) {
      return state.packageLookups.get(key);
    }

    const roots = readVisibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declaredPackageName,
      physicalPackageName,
      expectedPackageIdentity
    );

    if (state.packageLookups.size < MAX_PACKAGE_LOOKUP_CACHE_ENTRIES) {
      state.packageLookups.set(key, roots);
    }

    return roots;
  };

const moduleResolutionRoots = function moduleResolutionRoots(
  state: CompilerHostState,
  specifier: string,
  containingFile: string
): ReadonlySet<string> {
  if (!isBarePackageSpecifier(specifier)) {
    return containingPackageRoots(state, containingFile);
  }

  const roots = new Set<string>();

  for (const {
    declared,
    expectedIdentity,
    physical,
  } of externalPackageCandidates(specifier)) {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declared,
      physical,
      expectedIdentity
    );

    if (packageRoots !== undefined) {
      roots.add(packageRoots.canonicalRoot);
      roots.add(packageRoots.logicalRoot);
    }
  }

  return roots;
};

const moduleResolutionCache = function moduleResolutionCache(
  state: CompilerHostState,
  resolutionRoots: ReadonlySet<string>,
  options: ts.CompilerOptions
): ts.ModuleResolutionCache {
  const key = JSON.stringify([...resolutionRoots].toSorted());
  const existing = state.moduleResolutionCaches.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const cache = ts.createModuleResolutionCache(
    state.defaultHost.getCurrentDirectory(),
    (fileName) => state.defaultHost.getCanonicalFileName(fileName),
    options
  );

  if (state.moduleResolutionCaches.size < MAX_PACKAGE_LOOKUP_CACHE_ENTRIES) {
    state.moduleResolutionCaches.set(key, cache);
  }

  return cache;
};

const isResolvedExternalPackage = function isResolvedExternalPackage(
  specifier: string,
  resolvedModule: ts.ResolvedModuleFull | undefined
): resolvedModule is ts.ResolvedModuleFull {
  // Windows junctions may not be external; root checks still prove ownership.
  return isBarePackageSpecifier(specifier) && resolvedModule !== undefined;
};

const declarationEntrypointBelongsToRoot =
  function declarationEntrypointBelongsToRoot(
    packageRoot: string,
    declarationPath: string,
    observer: PackageBoundaryObserver
  ): boolean {
    const canonicalDeclarationPath = canonicalPath(declarationPath, observer);

    if (
      canonicalDeclarationPath === undefined ||
      !isPathWithin(packageRoot, canonicalDeclarationPath)
    ) {
      return false;
    }

    const materializedOwner = findMaterializedPackageRoot(
      canonicalDeclarationPath,
      observer
    );

    return materializedOwner === undefined || materializedOwner === packageRoot;
  };

const visibleTypeReferenceCandidateRoots =
  function visibleTypeReferenceCandidateRoots(
    state: CompilerHostState,
    containingFile: string,
    declaredPackageName: string,
    physicalPackageName: string,
    resolvedFileName: string,
    expectedPackageIdentity?: string
  ): PackageRootCapability | undefined {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declaredPackageName,
      physicalPackageName,
      expectedPackageIdentity
    );

    return packageRoots !== undefined &&
      declarationEntrypointBelongsToRoot(
        packageRoots.canonicalRoot,
        resolvedFileName,
        state.compilerWorkSession.packageBoundaryObserver
      )
      ? packageRoots
      : undefined;
  };

const visibleExternalPackageRoots = function visibleExternalPackageRoots(
  state: CompilerHostState,
  containingFile: string,
  specifier: string,
  resolvedFileName: string
): PackageRootCapability | undefined {
  return externalPackageCandidates(specifier)
    .map(({ declared, expectedIdentity, physical }) =>
      visibleTypeReferenceCandidateRoots(
        state,
        containingFile,
        declared,
        physical,
        resolvedFileName,
        expectedIdentity
      )
    )
    .find((root) => root !== undefined);
};

const allowResolvedPackageRoots = function allowResolvedPackageRoots(
  state: CompilerHostState,
  packageRoots: PackageRootCapability | undefined
): boolean {
  if (packageRoots === undefined) {
    return false;
  }

  state.allowedPackageRoots.add(packageRoots.canonicalRoot);
  state.allowedPackageRoots.add(packageRoots.logicalRoot);

  return true;
};

const authorizeExternalPackage = function authorizeExternalPackage(
  state: CompilerHostState,
  specifier: string,
  containingFile: string,
  resolvedModule: ts.ResolvedModuleFull | undefined
): boolean {
  if (!isResolvedExternalPackage(specifier, resolvedModule)) {
    return true;
  }

  // Every referenced Package Module must be declared by the containing
  // package, including TypeScript's automatic @types fallback, even when a
  // hoisted physical installation happens to resolve.
  const packageRoots = visibleExternalPackageRoots(
    state,
    containingFile,
    specifier,
    resolvedModule.resolvedFileName
  );

  return allowResolvedPackageRoots(state, packageRoots);
};

const resolveModuleLiteral = function resolveModuleLiteral(
  state: CompilerHostState,
  moduleLiteral: ts.StringLiteralLike,
  containingFile: string,
  redirectedReference: ts.ResolvedProjectReference | undefined,
  options: ts.CompilerOptions,
  containingSourceFile: ts.SourceFile
): ts.ResolvedModuleWithFailedLookupLocations {
  const mode = ts.getModeForUsageLocation(
    containingSourceFile,
    moduleLiteral,
    options
  );

  const resolutionRoots = moduleResolutionRoots(
    state,
    moduleLiteral.text,
    containingFile
  );

  const relativeCandidate = nodePath.resolve(
    nodePath.dirname(containingFile),
    moduleLiteral.text
  );

  if (
    !isBarePackageSpecifier(moduleLiteral.text) &&
    !isAuthorizedResolutionPath(resolutionRoots, relativeCandidate)
  ) {
    throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
  }

  const resolution = ts.resolveModuleName(
    moduleLiteral.text,
    containingFile,
    options,
    createBoundedResolutionHost(state, resolutionRoots),
    moduleResolutionCache(state, resolutionRoots, options),
    redirectedReference,
    mode
  );

  // Relative imports cannot authorize another package root.
  const permitted = authorizeExternalPackage(
    state,
    moduleLiteral.text,
    containingFile,
    resolution.resolvedModule
  );

  const resolvedModule = permitted ? resolution.resolvedModule : undefined;

  const authorizedResolution = permitted
    ? resolution
    : { ...resolution, resolvedModule };

  const resolvedPath = authorizedResolution.resolvedModule?.resolvedFileName;
  state.compilerWorkSession.observeResolution({
    accessStyle: mode === ts.ModuleKind.CommonJS ? "require" : "import",
    allowedRoots: [...resolutionRoots],
    containingFile,
    kind: "module",
    ...(resolvedPath !== undefined && { resolvedPath }),
    specifier: moduleLiteral.text,
  });

  return authorizedResolution;
};

const typeReferencePackageCandidates = function typeReferencePackageCandidates(
  referenceName: string
): readonly string[] {
  const declarationProvider =
    declarationProviderSegments(referenceName).join("/");

  return declarationProvider === referenceName
    ? [referenceName]
    : [referenceName, declarationProvider];
};

const alreadyAllowedTypeReferenceRoots =
  function alreadyAllowedTypeReferenceRoots(
    state: CompilerHostState,
    referenceName: string
  ): Set<string> {
    const packageNames = new Set(typeReferencePackageCandidates(referenceName));
    const { packageBoundaryObserver: observer } = state.compilerWorkSession;

    return new Set(
      [...state.allowedPackageRoots].filter((root) =>
        packageNames.has(
          readInstalledManifest(root, observer).packageIdentity.name
        )
      )
    );
  };

const typeReferenceResolutionRoots = function typeReferenceResolutionRoots(
  state: CompilerHostState,
  referenceName: string,
  containingFile: string
): ReadonlySet<string> {
  const roots = alreadyAllowedTypeReferenceRoots(state, referenceName);

  for (const candidate of typeReferencePackageCandidates(referenceName)) {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      candidate,
      candidate
    );

    if (packageRoots !== undefined) {
      roots.add(packageRoots.canonicalRoot);
      roots.add(packageRoots.logicalRoot);
    }
  }

  return roots;
};

const visibleTypeReferenceRoots = function visibleTypeReferenceRoots(
  state: CompilerHostState,
  containingFile: string,
  referenceName: string,
  resolvedFileName: string
): PackageRootCapability | undefined {
  return typeReferencePackageCandidates(referenceName)
    .map((candidate) =>
      visibleTypeReferenceCandidateRoots(
        state,
        containingFile,
        candidate,
        candidate,
        resolvedFileName
      )
    )
    .find((root) => root !== undefined);
};

const authorizeResolvedTypeReference = function authorizeResolvedTypeReference(
  state: CompilerHostState,
  referenceName: string,
  containingFile: string,
  resolution: ts.ResolvedTypeReferenceDirective
): boolean {
  const { resolvedFileName } = resolution;

  if (resolvedFileName === undefined) {
    return true;
  }

  const canonicalResolvedFile =
    canonicalEvidenceCandidatePath(resolvedFileName);

  if (
    canonicalResolvedFile !== undefined &&
    [...alreadyAllowedTypeReferenceRoots(state, referenceName)].some((root) =>
      isPathWithin(root, canonicalResolvedFile)
    )
  ) {
    return true;
  }

  const packageRoots = visibleTypeReferenceRoots(
    state,
    containingFile,
    referenceName,
    resolvedFileName
  );

  if (packageRoots === undefined) {
    return false;
  }

  return allowResolvedPackageRoots(state, packageRoots);
};

const authorizeTypeReferenceDirective =
  function authorizeTypeReferenceDirective(
    state: CompilerHostState,
    referenceName: string,
    containingFile: string,
    resolution: ts.ResolvedTypeReferenceDirective | undefined
  ): boolean {
    if (resolution === undefined) {
      return true;
    }

    return authorizeResolvedTypeReference(
      state,
      referenceName,
      containingFile,
      resolution
    );
  };

const resolveTypeReferenceDirectiveReference =
  function resolveTypeReferenceDirectiveReference(
    state: CompilerHostState,
    reference: ts.FileReference | string,
    containingFile: string,
    redirectedReference: ts.ResolvedProjectReference | undefined,
    options: ts.CompilerOptions,
    containingSourceFile: ts.SourceFile | undefined
  ): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations {
    const referenceName = Predicate.isString(reference)
      ? reference
      : reference.fileName;

    const mode = ts.getModeForFileReference(
      reference,
      containingSourceFile?.impliedNodeFormat
    );

    const cacheKey = `${containingFile}\0${referenceName}\0${mode}`;
    const cachedResolution = state.typeReferenceResolutions.get(cacheKey);

    if (cachedResolution !== undefined) {
      return cachedResolution;
    }

    const resolutionRoots = typeReferenceResolutionRoots(
      state,
      referenceName,
      containingFile
    );

    const resolution = ts.resolveTypeReferenceDirective(
      referenceName,
      containingFile,
      options,
      createBoundedResolutionHost(state, resolutionRoots),
      redirectedReference,
      undefined,
      mode
    );

    const permitted = authorizeTypeReferenceDirective(
      state,
      referenceName,
      containingFile,
      resolution.resolvedTypeReferenceDirective
    );

    const resolvedTypeReferenceDirective = permitted
      ? resolution.resolvedTypeReferenceDirective
      : undefined;

    const authorizedResolution = permitted
      ? resolution
      : { ...resolution, resolvedTypeReferenceDirective };

    const resolvedPath =
      authorizedResolution.resolvedTypeReferenceDirective?.resolvedFileName;

    state.compilerWorkSession.observeResolution({
      ...(mode !== undefined && {
        accessStyle: mode === ts.ModuleKind.CommonJS ? "require" : "import",
      }),
      allowedRoots: [...resolutionRoots],
      containingFile,
      kind: "type-reference",
      ...(resolvedPath !== undefined && { resolvedPath }),
      specifier: referenceName,
    });
    state.typeReferenceResolutions.set(cacheKey, authorizedResolution);

    return authorizedResolution;
  };

const resolveReadablePath = function resolveReadablePath(
  fileName: string,
  onError?: (message: string) => void
): string | undefined {
  try {
    // Canonicalize before containment checks to reject symlink escapes.
    return realpathSync.native(fileName);
  } catch (error) {
    onError?.(String(error));

    return undefined;
  }
};

const assertAllowedSource = function assertAllowedSource(
  allowedRoots: ReadonlySet<string>,
  sourcePath: string
): void {
  if (
    !isTypeScriptStandardLibraryDeclaration(sourcePath) &&
    ![...allowedRoots].some((allowedRoot) =>
      isPathWithin(allowedRoot, sourcePath)
    )
  ) {
    throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
  }
};

const incrementSourceFileCount = function incrementSourceFileCount(
  state: CompilerHostState
): void {
  state.sourceFileCount += 1;

  if (state.sourceFileCount > INSPECTION_BUDGET_POLICY.declarationSourceFiles) {
    throw new InspectionLimitError(
      "declaration-files",
      "Inspection exceeded its declaration file limit."
    );
  }
};

const readSourceText = function readSourceText(
  state: CompilerHostState,
  sourcePath: string,
  onError?: (message: string) => void
): string | undefined {
  try {
    const sourceText = readBoundedUtf8File(
      sourcePath,
      INSPECTION_BUDGET_POLICY.declarationSourceBytes - state.sourceByteCount,
      "declaration-bytes",
      "Inspection exceeded its declaration byte limit."
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
};

const getBoundedSourceFile = function getBoundedSourceFile(
  state: CompilerHostState,
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  onError?: (message: string) => void
): ts.SourceFile | undefined {
  if (state.sourceFileCache.has(fileName)) {
    return state.sourceFileCache.get(fileName);
  }

  reserveCompilerHostOperations(state, 2);

  if (!isAuthorizedSourceCandidate(state.allowedPackageRoots, fileName)) {
    throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
  }

  const installedSourcePath = resolveReadablePath(fileName, onError);

  if (installedSourcePath === undefined) {
    state.sourceFileCache.set(fileName, undefined);

    return undefined;
  }

  assertAllowedSource(state.allowedPackageRoots, installedSourcePath);
  incrementSourceFileCount(state);
  const sourceText = readSourceText(state, installedSourcePath, onError);

  const sourceFile =
    sourceText === undefined
      ? undefined
      : ts.createSourceFile(fileName, sourceText, languageVersion, true);

  if (sourceFile !== undefined && sourceText !== undefined) {
    // Standard-library format is controlled by the pinned compiler, not Installed Evidence.
    const mode = isTypeScriptStandardLibraryDeclaration(installedSourcePath)
      ? undefined
      : sourceFile.impliedNodeFormat;

    state.compilerWorkSession.observeEvidenceFile(
      installedSourcePath,
      sourceText,
      "declaration",
      mode === undefined
        ? undefined
        : {
            accessStyle: mode === ts.ModuleKind.CommonJS ? "require" : "import",
            path: fileName,
          }
    );
  }

  state.sourceFileCache.set(fileName, sourceFile);

  return sourceFile;
};

const createBoundedCompilerHost = function createBoundedCompilerHost(
  packageRoots: readonly string[],
  resolutionContextDirectory: string,
  compilerOptions: ts.CompilerOptions,
  compilerWorkSession: CompilerWorkSession
): BoundedCompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const readOnlyDefaultHost = withoutCompilerDirectoryReader(defaultHost);

  const resolutionHostBase: ts.CompilerHost = {
    ...readOnlyDefaultHost,
    getCurrentDirectory: () => resolutionContextDirectory,
    writeFile: rejectCompilerWrite,
  };

  const authorizedPackageRoots = packageRoots.flatMap((packageRoot) => {
    const canonicalPackageRoot = canonicalPath(
      packageRoot,
      compilerWorkSession.packageBoundaryObserver
    );

    if (canonicalPackageRoot === undefined) {
      throw new UnsupportedInspectionError(
        "The installed package boundary could not be canonicalized."
      );
    }

    return [nodePath.resolve(packageRoot), canonicalPackageRoot];
  });

  if (authorizedPackageRoots.length === 0) {
    throw new UnsupportedInspectionError(
      "The installed package boundary is missing."
    );
  }

  const state: CompilerHostState = {
    allowedPackageRoots: new Set(authorizedPackageRoots),
    compilerWorkSession,
    defaultHost: resolutionHostBase,
    directoriesCache: new Map(),
    directoryExistsCache: new Map(),
    fileExistsCache: new Map(),
    moduleResolutionCaches: new Map(),
    packageLookups: new Map(),
    readFileCache: new Map(),
    realpathCache: new Map(),
    sourceByteCount: 0,
    sourceFileCache: new Map(),
    sourceFileCount: 0,
    typeReferenceResolutions: new Map(),
  };

  const resolutionHost = createBoundedResolutionHost(state);
  const { packageBoundaryObserver } = state.compilerWorkSession;

  const programSourceFiles = new WeakMap<
    ts.Program,
    ReadonlyMap<string, ts.SourceFile>
  >();

  // Bare imports may add compiler-resolved roots to this allowlist.
  return {
    ...readOnlyDefaultHost,
    allowPackageRoot: (packageRoot) => {
      state.allowedPackageRoots.add(packageRoot.canonical);
      state.allowedPackageRoots.add(nodePath.resolve(packageRoot.logical));
      state.typeReferenceResolutions.clear();
    },
    fileExists: (fileName) => resolutionHost.fileExists(fileName),
    findProgramSourceFile: (program, fileName) => {
      reserveCompilerHostOperations(state, 1);
      let sourceFiles = programSourceFiles.get(program);

      if (sourceFiles === undefined) {
        const indexedSourceFiles = new Map<string, ts.SourceFile>();

        for (const sourceFile of program.getSourceFiles()) {
          if (
            !isAuthorizedSourceCandidate(
              state.allowedPackageRoots,
              sourceFile.fileName
            )
          ) {
            continue;
          }

          const canonicalFileName = canonicalPath(
            sourceFile.fileName,
            packageBoundaryObserver
          );

          if (canonicalFileName !== undefined) {
            indexedSourceFiles.set(canonicalFileName, sourceFile);
          }
        }

        sourceFiles = indexedSourceFiles;
        programSourceFiles.set(program, sourceFiles);
      }

      if (!isAuthorizedSourceCandidate(state.allowedPackageRoots, fileName)) {
        throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
      }

      const canonicalFileName = canonicalPath(
        fileName,
        packageBoundaryObserver
      );

      return canonicalFileName === undefined
        ? undefined
        : sourceFiles.get(canonicalFileName);
    },
    getCurrentDirectory: () => resolutionContextDirectory,
    packageBoundaryObserver,
    readFile: (fileName): string | undefined =>
      resolutionHost.readFile(fileName),
    writeFile: rejectCompilerWrite,
    ...(resolutionHost.directoryExists !== undefined && {
      directoryExists: (directoryName: string) =>
        resolutionHost.directoryExists?.(directoryName) ?? false,
    }),
    ...(resolutionHost.getDirectories !== undefined && {
      getDirectories: (directoryName: string) =>
        resolutionHost.getDirectories?.(directoryName) ?? [],
    }),
    ...(resolutionHost.realpath !== undefined && {
      realpath: (path: string) => resolutionHost.realpath?.(path) ?? path,
    }),
    getSourceFile: (fileName, languageVersion, onError) =>
      getBoundedSourceFile(state, fileName, languageVersion, onError),
    resolveModuleNameLiterals: (
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
      containingSourceFile
    ) =>
      moduleLiterals.map((moduleLiteral) =>
        resolveModuleLiteral(
          state,
          moduleLiteral,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile
        )
      ),
    resolveTypeReferenceDirectiveReferences: (
      typeDirectiveReferences,
      containingFile,
      redirectedReference,
      options,
      containingSourceFile
    ) =>
      typeDirectiveReferences.map((reference) =>
        resolveTypeReferenceDirectiveReference(
          state,
          reference,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile
        )
      ),
  };
};

const ambientModuleName = function ambientModuleName(
  symbol: ts.Symbol
): string {
  const name = symbol.getName();

  return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
};

const packageModuleSymbol = function packageModuleSymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  ambientSpecifier: string | undefined
): ts.Symbol | undefined {
  const sourceFileSymbol = checker.getSymbolAtLocation(sourceFile);

  if (sourceFileSymbol !== undefined || ambientSpecifier === undefined) {
    return sourceFileSymbol;
  }

  return checker
    .getAmbientModules()
    .find((symbol) => ambientModuleName(symbol) === ambientSpecifier);
};

const initialPackageEvidence = function initialPackageEvidence(
  program: ts.Program,
  selection: InstalledProgramSelection
):
  | {
      readonly moduleSymbol: ts.Symbol;
    }
  | undefined {
  if (selection.kind !== "package") {
    return undefined;
  }

  const sourceFile = program.getSourceFile(
    selection.declarationAuthority.declarationPath
  );

  const moduleSymbol =
    sourceFile === undefined
      ? undefined
      : packageModuleSymbol(
          program.getTypeChecker(),
          sourceFile,
          selection.ambientSpecifier
        );

  return moduleSymbol === undefined ? undefined : { moduleSymbol };
};

const selectedValueNeedsStandardLibrary =
  function selectedValueNeedsStandardLibrary(
    checker: ts.TypeChecker,
    symbol: ts.Symbol
  ): boolean {
    const declaration = symbol.valueDeclaration;

    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
      return false;
    }

    const { type } = declaration;

    const typeSymbol =
      type !== undefined && ts.isTypeReferenceNode(type)
        ? checker.getSymbolAtLocation(type.typeName)
        : undefined;

    if (type === undefined) {
      return false;
    }

    if (!ts.isTypeReferenceNode(type)) {
      return false;
    }

    return (
      typeSymbol === undefined || (typeSymbol.declarations ?? []).length === 0
    );
  };

const inheritedConstructorNeedsStandardLibrary =
  function inheritedConstructorNeedsStandardLibrary(
    checker: ts.TypeChecker,
    declaration: ts.ClassDeclaration,
    visited: Set<ts.ClassDeclaration>,
    depth: number
  ): boolean {
    if (
      declaration.members.some(ts.isConstructorDeclaration) ||
      visited.has(declaration) ||
      depth > 64
    ) {
      return false;
    }

    visited.add(declaration);

    return (declaration.heritageClauses ?? []).some((clause) =>
      clause.types.some((heritage) => {
        const symbol = checker.getSymbolAtLocation(heritage.expression);

        if (symbol === undefined) {
          return true;
        }

        const target = bitwiseAnd(symbol.flags, ts.SymbolFlags.Alias)
          ? checker.getAliasedSymbol(symbol)
          : symbol;

        return (target.declarations ?? []).some(
          (baseDeclaration) =>
            ts.isClassDeclaration(baseDeclaration) &&
            inheritedConstructorNeedsStandardLibrary(
              checker,
              baseDeclaration,
              visited,
              depth + 1
            )
        );
      })
    );
  };

const selectedExportNeedsStandardLibrary =
  function selectedExportNeedsStandardLibrary(
    checker: ts.TypeChecker,
    moduleSymbol: ts.Symbol,
    exportName: string
  ): boolean {
    const exportedSymbol = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.getName() === exportName);

    if (exportedSymbol === undefined) {
      return false;
    }

    const symbol = bitwiseAnd(exportedSymbol.flags, ts.SymbolFlags.Alias)
      ? checker.getAliasedSymbol(exportedSymbol)
      : exportedSymbol;

    return (
      selectedValueNeedsStandardLibrary(checker, symbol) ||
      (symbol.declarations ?? []).some(
        (declaration) =>
          ts.isClassDeclaration(declaration) &&
          inheritedConstructorNeedsStandardLibrary(
            checker,
            declaration,
            new Set(),
            0
          )
      )
    );
  };

const reserveDeclarationGraphNodes = function reserveDeclarationGraphNodes(
  traversal: DeclarationGraphTraversalState,
  count: number
): void {
  traversal.nodeCount += count;

  if (traversal.nodeCount > INSPECTION_BUDGET_POLICY.declarationGraphNodes) {
    throw new InspectionLimitError(
      "declaration-graph",
      "Inspection exceeded its declaration graph traversal limit."
    );
  }
};

const visitedDeclarationEntry = function visitedDeclarationEntry(
  state: ReExportGraphState,
  declaration: ts.Declaration,
  expandSourceExports: boolean
): boolean {
  const alreadyVisited = state.visitedDeclarations.has(declaration);
  state.visitedDeclarations.add(declaration);

  return (
    alreadyVisited && (!ts.isSourceFile(declaration) || !expandSourceExports)
  );
};

const unresolvedDeclarationReference =
  function unresolvedDeclarationReference(): UnsupportedInspectionError {
    return new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  };

const requiredProgramSourceFile = function requiredProgramSourceFile(
  program: ts.Program,
  fileName: string,
  host: BoundedCompilerHost
): ts.SourceFile {
  const sourceFile = host.findProgramSourceFile(program, fileName);

  if (sourceFile === undefined) {
    throw unresolvedDeclarationReference();
  }

  return sourceFile;
};

const resolvedTypeReferenceSourceFile =
  function resolvedTypeReferenceSourceFile(
    program: ts.Program,
    containingFile: ts.SourceFile,
    reference: ts.FileReference,
    host: BoundedCompilerHost
  ): ts.SourceFile {
    const resolution = host.resolveTypeReferenceDirectiveReferences(
      [reference],
      containingFile.fileName,
      undefined,
      program.getCompilerOptions(),
      containingFile,
      undefined
    )[0]?.resolvedTypeReferenceDirective;

    const resolvedFileName = resolution?.resolvedFileName;

    if (resolvedFileName === undefined) {
      throw unresolvedDeclarationReference();
    }

    return requiredProgramSourceFile(program, resolvedFileName, host);
  };

const referencedDeclarationSourceFiles =
  function referencedDeclarationSourceFiles(
    program: ts.Program,
    declaration: ts.Declaration,
    host: BoundedCompilerHost,
    traversal: DeclarationGraphTraversalState
  ): readonly ts.SourceFile[] {
    if (!ts.isSourceFile(declaration)) {
      return [];
    }

    reserveDeclarationGraphNodes(
      traversal,
      declaration.referencedFiles.length +
        declaration.typeReferenceDirectives.length
    );

    return [
      ...declaration.referencedFiles.map((reference) =>
        requiredProgramSourceFile(
          program,
          nodePath.resolve(
            nodePath.dirname(declaration.fileName),
            reference.fileName
          ),
          host
        )
      ),
      ...declaration.typeReferenceDirectives.map((reference) =>
        resolvedTypeReferenceSourceFile(program, declaration, reference, host)
      ),
    ];
  };

const enqueueReferencedDeclarationFiles =
  function enqueueReferencedDeclarationFiles(
    program: ts.Program,
    host: BoundedCompilerHost,
    traversal: DeclarationGraphTraversalState,
    state: ReExportGraphState,
    sourceFile: ts.SourceFile
  ): void {
    if (state.visitedReferenceSourceFiles.has(sourceFile.fileName)) {
      return;
    }

    state.visitedReferenceSourceFiles.add(sourceFile.fileName);
    state.pendingEntries.push(
      ...referencedDeclarationSourceFiles(
        program,
        sourceFile,
        host,
        traversal
      ).map((referenced): PendingDeclarationGraphEntry => ({
        declaration: referenced,
        expandSourceExports: true,
      }))
    );
  };

const hasModuleSpecifier = function hasModuleSpecifier(
  statement: ts.Statement
): statement is ts.ExportDeclaration & {
  readonly moduleSpecifier: ts.Expression;
} {
  return (
    ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
  );
};

const resolvedModuleDeclarations = function resolvedModuleDeclarations(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression
): readonly ts.Declaration[] {
  const referencedModule = checker.getSymbolAtLocation(moduleSpecifier);

  if (referencedModule === undefined) {
    throw new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  }

  const declarations = referencedModule.declarations ?? [];

  if (declarations.length === 0) {
    throw new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  }

  return declarations;
};

const resolvedModuleSourceFiles = function resolvedModuleSourceFiles(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression
): readonly ts.SourceFile[] {
  return resolvedModuleDeclarations(checker, moduleSpecifier).filter(
    ts.isSourceFile
  );
};

const reExportedStatementDeclarations =
  function reExportedStatementDeclarations(
    checker: ts.TypeChecker,
    statement: ts.ExportDeclaration & {
      readonly moduleSpecifier: ts.Expression;
    }
  ): readonly PendingDeclarationGraphEntry[] {
    if (
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.flatMap((element) => {
        const symbol = checker.getSymbolAtLocation(element.name);

        const resolved =
          symbol !== undefined && bitwiseAnd(symbol.flags, ts.SymbolFlags.Alias)
            ? checker.getAliasedSymbol(symbol)
            : symbol;

        const declarations = resolved?.declarations ?? [];

        if (declarations.length === 0) {
          throw unresolvedDeclarationReference();
        }

        return declarations.map(
          (declaration): PendingDeclarationGraphEntry => ({
            declaration,
            expandSourceExports: false,
          })
        );
      });
    }

    return resolvedModuleSourceFiles(checker, statement.moduleSpecifier).map(
      (declaration): PendingDeclarationGraphEntry => ({
        declaration,
        expandSourceExports: true,
      })
    );
  };

const reExportedDeclarations = function reExportedDeclarations(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): readonly PendingDeclarationGraphEntry[] {
  return sourceFile.statements
    .filter(hasModuleSpecifier)
    .flatMap((statement) =>
      reExportedStatementDeclarations(checker, statement)
    );
};

const expandReExportSource = function expandReExportSource(
  checker: ts.TypeChecker,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  sourceFile: ts.SourceFile
): void {
  if (state.visitedExpandedSourceFiles.has(sourceFile.fileName)) {
    return;
  }

  state.visitedExpandedSourceFiles.add(sourceFile.fileName);
  reserveDeclarationGraphNodes(traversal, sourceFile.statements.length);
  state.pendingEntries.push(...reExportedDeclarations(checker, sourceFile));
};

const importTypeSpecifier = function importTypeSpecifier(
  node: ts.Node
): ts.Expression | undefined {
  if (!ts.isImportTypeNode(node)) {
    return undefined;
  }

  if (!ts.isLiteralTypeNode(node.argument)) {
    return undefined;
  }

  return ts.isStringLiteralLike(node.argument.literal)
    ? node.argument.literal
    : undefined;
};

const descendantImportTypeSpecifiers = function descendantImportTypeSpecifiers(
  root: ts.Node,
  traversal: DeclarationGraphTraversalState
): readonly ts.Expression[] {
  const specifiers: ts.Expression[] = [];

  const visit = (node: ts.Node, depth: number): void => {
    traversal.nodeCount += 1;

    if (
      depth > MAX_DECLARATION_GRAPH_DEPTH ||
      traversal.nodeCount > INSPECTION_BUDGET_POLICY.declarationGraphNodes
    ) {
      throw new InspectionLimitError(
        "declaration-graph",
        "Inspection exceeded its declaration graph traversal limit."
      );
    }

    const specifier = importTypeSpecifier(node);

    if (specifier !== undefined) {
      specifiers.push(specifier);
    }

    ts.forEachChild(node, (child) => {
      visit(child, depth + 1);
    });
  };

  visit(root, 0);

  return specifiers;
};

const inspectReExportGraphEntry = function inspectReExportGraphEntry(
  program: ts.Program,
  checker: ts.TypeChecker,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  entry: PendingDeclarationGraphEntry
): void {
  const { declaration, expandSourceExports } = entry;

  if (visitedDeclarationEntry(state, declaration, expandSourceExports)) {
    return;
  }

  enqueueReferencedDeclarationFiles(
    program,
    host,
    traversal,
    state,
    declaration.getSourceFile()
  );

  if (ts.isSourceFile(declaration) && expandSourceExports) {
    expandReExportSource(checker, traversal, state, declaration);

    return;
  }

  for (const specifier of descendantImportTypeSpecifiers(
    declaration,
    traversal
  )) {
    resolvedModuleDeclarations(checker, specifier);
  }
};

const assertResolvedReExportGraph = function assertResolvedReExportGraph(
  program: ts.Program,
  checker: ts.TypeChecker,
  entrypoint: ts.SourceFile,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState
): void {
  const state: ReExportGraphState = {
    pendingEntries: [{ declaration: entrypoint, expandSourceExports: true }],
    visitedDeclarations: new Set(),
    visitedExpandedSourceFiles: new Set(),
    visitedReferenceSourceFiles: new Set(),
  };

  for (const entry of state.pendingEntries) {
    inspectReExportGraphEntry(program, checker, host, traversal, state, entry);
  }
};

const moduleStatementTraversal = {
  moduleBodyStatements(declaration: ts.Declaration): readonly ts.Statement[] {
    if (ts.isSourceFile(declaration)) {
      return declaration.statements;
    }

    return moduleStatementTraversal.moduleDeclarationStatements(declaration);
  },
  moduleDeclarationStatements(
    declaration: ts.Declaration
  ): readonly ts.Statement[] {
    if (!ts.isModuleDeclaration(declaration)) {
      return [];
    }

    const { body } = declaration;

    if (body === undefined) {
      return [];
    }

    return ts.isModuleBlock(body)
      ? body.statements
      : moduleStatementTraversal.moduleBodyStatements(body);
  },
};

const externalImportSpecifier = function externalImportSpecifier(
  statement: ts.ImportEqualsDeclaration
): ts.Expression | undefined {
  return ts.isExternalModuleReference(statement.moduleReference)
    ? statement.moduleReference.expression
    : undefined;
};

const externalImportEqualsSpecifiers = function externalImportEqualsSpecifiers(
  statement: ts.ImportEqualsDeclaration
): readonly ts.Expression[] {
  const specifier = externalImportSpecifier(statement);

  return specifier === undefined ? [] : [specifier];
};

const ambientModuleReferenceSpecifiers =
  function ambientModuleReferenceSpecifiers(
    statement: ts.Statement
  ): readonly ts.Expression[] {
    if (hasModuleSpecifier(statement)) {
      return [statement.moduleSpecifier];
    }

    if (ts.isImportDeclaration(statement)) {
      return [statement.moduleSpecifier];
    }

    return ts.isImportEqualsDeclaration(statement)
      ? externalImportEqualsSpecifiers(statement)
      : [];
  };

const ambientReExportSpecifiers = function ambientReExportSpecifiers(
  declaration: ts.Declaration,
  traversal: DeclarationGraphTraversalState
): readonly ts.Expression[] {
  const statements = moduleStatementTraversal.moduleBodyStatements(declaration);

  return [
    ...statements.flatMap(ambientModuleReferenceSpecifiers),
    ...statements.flatMap((statement) =>
      descendantImportTypeSpecifiers(statement, traversal)
    ),
  ];
};

const assertResolvedAmbientModuleReExports =
  function assertResolvedAmbientModuleReExports(
    program: ts.Program,
    checker: ts.TypeChecker,
    moduleSymbol: ts.Symbol,
    host: BoundedCompilerHost,
    traversal: DeclarationGraphTraversalState
  ): void {
    const pendingDeclarations: ts.Declaration[] = (
      moduleSymbol.declarations ?? []
    ).filter(ts.isModuleDeclaration);

    const visitedDeclarations = new Set<ts.Declaration>();

    for (const declaration of pendingDeclarations) {
      if (visitedDeclarations.has(declaration)) {
        continue;
      }

      visitedDeclarations.add(declaration);
      pendingDeclarations.push(
        ...ambientReExportSpecifiers(declaration, traversal).flatMap(
          (specifier) => resolvedModuleDeclarations(checker, specifier)
        ),
        ...referencedDeclarationSourceFiles(
          program,
          declaration,
          host,
          traversal
        )
      );
    }
  };

const inspectModuleEvidence = function inspectModuleEvidence(
  program: ts.Program,
  declarationPath: string,
  ambientSpecifier: string | undefined,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState
): InstalledProgramEvidence {
  const sourceFile = program.getSourceFile(declarationPath);

  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module."
    );
  }

  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(program, checker, sourceFile, host, traversal);

  const moduleSymbol = packageModuleSymbol(
    checker,
    sourceFile,
    ambientSpecifier
  );

  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module."
    );
  }

  assertResolvedAmbientModuleReExports(
    program,
    checker,
    moduleSymbol,
    host,
    traversal
  );

  return { checker, moduleSymbol };
};

const inspectPlatformModuleEvidence = function inspectPlatformModuleEvidence(
  program: ts.Program,
  declarationPath: string,
  specifier: string,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState
): InstalledProgramEvidence {
  const sourceFile = program.getSourceFile(declarationPath);

  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The visible Declaration Provider has no readable module declarations."
    );
  }

  const checker = program.getTypeChecker();
  assertResolvedReExportGraph(program, checker, sourceFile, host, traversal);

  const moduleSymbol = checker
    .getAmbientModules()
    .find((symbol) => ambientModuleName(symbol) === specifier);

  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${specifier}" is not declared by the visible @types/node provider.`
    );
  }

  assertResolvedAmbientModuleReExports(
    program,
    checker,
    moduleSymbol,
    host,
    traversal
  );

  return { checker, moduleSymbol };
};

const inspectSelectedModule = function inspectSelectedModule(
  program: ts.Program,
  selection: InstalledProgramSelection,
  host: BoundedCompilerHost,
  traversal: DeclarationGraphTraversalState
): InstalledProgramEvidence {
  if (selection.kind === "package") {
    return inspectModuleEvidence(
      program,
      selection.declarationAuthority.declarationPath,
      selection.ambientSpecifier,
      host,
      traversal
    );
  }

  return inspectPlatformModuleEvidence(
    program,
    selection.declarationAuthority.declarationPath,
    selection.specifier,
    host,
    traversal
  );
};

export const materializeInstalledProgram = function materializeInstalledProgram(
  selection: InstalledProgramSelection,
  queries: readonly InspectionPlanQuery[]
): InstalledProgramEvidence {
  const { declarationPath, root: declarationRoot } =
    selection.declarationAuthority;

  const requirements = installedProgramRequirements(queries);
  const traversal: DeclarationGraphTraversalState = { nodeCount: 0 };

  const compilerOptions = inspectionCompilerOptions(
    requirements.needsStandardLibrary
  );

  const host = createBoundedCompilerHost(
    [declarationRoot.canonical, declarationRoot.logical],
    selection.resolutionContextDirectory,
    compilerOptions,
    selection.compilerWorkSession
  );

  const initialProgram = ts.createProgram({
    host,
    options: compilerOptions,
    rootNames: [declarationPath],
  });

  const initialEvidence = initialPackageEvidence(initialProgram, selection);

  const publicInterfaceProgram =
    !requirements.needsStandardLibrary &&
    initialEvidence !== undefined &&
    requirements.focusedExportNames.some((exportName) =>
      selectedExportNeedsStandardLibrary(
        initialProgram.getTypeChecker(),
        initialEvidence.moduleSymbol,
        exportName
      )
    )
      ? ts.createProgram({
          host,
          options: inspectionCompilerOptions(true),
          rootNames: [declarationPath],
        })
      : initialProgram;

  const initialSourceFile =
    publicInterfaceProgram.getSourceFile(declarationPath);

  const initialModuleSymbol =
    selection.kind === "package" && initialSourceFile !== undefined
      ? packageModuleSymbol(
          publicInterfaceProgram.getTypeChecker(),
          initialSourceFile,
          selection.ambientSpecifier
        )
      : undefined;

  const canAugmentNode =
    selection.kind !== "platform" && requirements.needsNodeAugmentation;

  const nodeProgram =
    !canAugmentNode ||
    initialSourceFile === undefined ||
    initialModuleSymbol === undefined
      ? undefined
      : selectNodeDeclarationProgram(
          publicInterfaceProgram,
          initialModuleSymbol,
          initialSourceFile,
          (): NodeProviderProgram | undefined => {
            const nodeProvider = selection.readNodeDeclarationProvider();

            if (nodeProvider === undefined) {
              return undefined;
            }

            host.allowPackageRoot(nodeProvider.root);

            return {
              program: ts.createProgram({
                host,
                options: publicInterfaceProgram.getCompilerOptions(),
                rootNames: [declarationPath, nodeProvider.declarationPath],
              }),
              providerRoot: nodeProvider.root.canonical,
            };
          },
          () => {
            reserveDeclarationGraphNodes(traversal, 1);
          },
          requirements.nodeAugmentationExportNames
        );

  const program = nodeProgram ?? publicInterfaceProgram;

  return inspectSelectedModule(program, selection, host, traversal);
};
