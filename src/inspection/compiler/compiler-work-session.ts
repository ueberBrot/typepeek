import nodePath from "node:path";

import { Result, Schema } from "effect";
import { constVoid } from "effect/Function";
import { ModuleKind, ModuleResolutionKind } from "tsrs/sync";
import type {
  ModuleResolver,
  RawCompilerOptions,
  ResolvedModule,
} from "tsrs/sync";

import { cachedCompilerLookup } from "#typepeek/inspection/compiler/compiler-cache";
import { CompilerSession } from "#typepeek/inspection/compiler/compiler-session";
import type { ResolutionFileSystem } from "#typepeek/inspection/compiler/compiler-session";
import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
  isEvidenceDirectory,
  isEvidenceFile,
  isPathWithin,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence/evidence-boundary";
import type {
  InstalledEvidenceObserver,
  InstalledEvidenceResolutionProbe,
  ObserveInstalledEvidenceDirectory,
  ObserveInstalledEvidenceFile,
} from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import type { PackageBoundaryObserver } from "#typepeek/inspection/evidence/installed-package-boundary";
import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/model/budget-policy";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import type { AccessStyle } from "#typepeek/inspection/model/protocol";
import { decodeJson } from "#typepeek/shared/json-data";

const COMPILER_HOST_BYTES = "compiler-host-bytes";
const PACKAGE_MANIFEST_FILE = "package.json";

const COMPILER_BYTES_LIMIT_MESSAGE =
  "Inspection exceeded its compiler host byte limit.";

const DEFAULT_COMPILER_RESOLUTION_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const decodeManifest = Schema.decodeUnknownResult(Schema.JsonObject);

const parseManifest = function parseManifest(
  manifestText: string
): Schema.JsonObject | undefined {
  try {
    return Result.getOrUndefined(
      decodeManifest(decodeJson(Schema.Unknown, manifestText))
    );
  } catch {
    return undefined;
  }
};

export interface PackageDeclarationResolver {
  readonly canonicalPath: (fileName: string) => string | undefined;
  readonly conditions: ReadonlySet<string>;
  readonly resolve: (specifier: string) => string | undefined;
}

export interface CompilerWorkSession {
  readonly native: CompilerSession;
  readonly resolveModule: (
    specifier: string,
    containingFile: string,
    allowedRoots: readonly string[],
    accessStyle: AccessStyle
  ) => ResolvedModule | undefined;
  readonly createPackageResolver: (
    resolutionContext: string,
    accessStyle: AccessStyle,
    allowedRoots: readonly string[]
  ) => PackageDeclarationResolver;
  readonly packageBoundaryObserver: PackageBoundaryObserver;
  readonly readResolutionFile: (fileName: string) => string;
  readonly readEvidenceFileFormat: (
    fileName: string,
    allowedRoots: readonly string[]
  ) => AccessStyle | undefined;
  readonly observeEvidenceFile: ObserveInstalledEvidenceFile;
  readonly observeEvidenceDirectory?: ObserveInstalledEvidenceDirectory;
  readonly observeResolution: (probe: InstalledEvidenceResolutionProbe) => void;
  readonly resolveEvidenceProbe: (
    probe: InstalledEvidenceResolutionProbe,
    allowedRoots: readonly string[]
  ) => string | undefined;
  readonly reserveOperations: (count?: number) => void;
}

export interface CompilerWorkLimits {
  readonly evidenceObserver?: InstalledEvidenceObserver;
  readonly operations?: number;
  readonly resolutionBytes?: number;
}

const crossesNestedPackageBoundary = function crossesNestedPackageBoundary(
  allowedRoot: string,
  candidate: string
): boolean {
  const segments = nodePath
    .relative(allowedRoot, candidate)
    .split(nodePath.sep);

  for (const [index, segment] of segments.entries()) {
    if (segment !== "node_modules") {
      continue;
    }

    const packageSegment = segments[index + 1];

    if (packageSegment === undefined) {
      return false;
    }

    return packageSegment.startsWith("@")
      ? segments[index + 2] !== undefined
      : true;
  }

  return false;
};

const isAuthorizedResolutionCandidate =
  function isAuthorizedResolutionCandidate(
    canonicalAllowedRoots: readonly string[],
    logicalAllowedRoots: readonly string[],
    candidate: string,
    allowAncestor: boolean
  ): boolean {
    const lexicalCandidate = nodePath.resolve(candidate);

    if (
      !logicalAllowedRoots.some(
        (allowedRoot) =>
          isPathWithin(allowedRoot, lexicalCandidate) ||
          (allowAncestor && isPathWithin(lexicalCandidate, allowedRoot))
      )
    ) {
      return false;
    }

    const canonicalCandidate = canonicalEvidenceCandidatePath(candidate);

    return (
      canonicalCandidate !== undefined &&
      (canonicalAllowedRoots.some(
        (allowedRoot) =>
          (isPathWithin(allowedRoot, canonicalCandidate) &&
            !crossesNestedPackageBoundary(allowedRoot, canonicalCandidate)) ||
          (allowAncestor && isPathWithin(canonicalCandidate, allowedRoot))
      ) ||
        (allowAncestor &&
          logicalAllowedRoots.some((allowedRoot) =>
            isPathWithin(lexicalCandidate, allowedRoot)
          )))
    );
  };

const isAuthorizedResolutionPath = function isAuthorizedResolutionPath(
  canonicalAllowedRoots: readonly string[],
  logicalAllowedRoots: readonly string[],
  candidate: string
): boolean {
  return isAuthorizedResolutionCandidate(
    canonicalAllowedRoots,
    logicalAllowedRoots,
    candidate,
    false
  );
};

const cachedResolutionResult = function cachedResolutionResult<Result>(
  reserveOperations: (count?: number) => void,
  cache: Map<string, Result>,
  key: string,
  read: () => Result
): Result {
  reserveOperations();

  return cachedCompilerLookup(cache, key, read);
};

const isAuthorizedResolutionDirectory =
  function isAuthorizedResolutionDirectory(
    canonicalAllowedRoots: readonly string[],
    logicalAllowedRoots: readonly string[],
    candidate: string
  ): boolean {
    return isAuthorizedResolutionCandidate(
      canonicalAllowedRoots,
      logicalAllowedRoots,
      candidate,
      true
    );
  };

const readPackageResolutionFile = function readPackageResolutionFile(
  fileName: string,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
  observeEvidenceFile: ObserveInstalledEvidenceFile
): string | undefined {
  try {
    const availableBytes = remainingBytes();

    const contents = readBoundedUtf8File(
      fileName,
      Math.min(MAX_MANIFEST_BYTES, availableBytes),
      availableBytes < MAX_MANIFEST_BYTES
        ? COMPILER_HOST_BYTES
        : "package-manifest-bytes",
      availableBytes < MAX_MANIFEST_BYTES
        ? COMPILER_BYTES_LIMIT_MESSAGE
        : "Inspection exceeded its package manifest size limit."
    );

    reserveBytes(Buffer.byteLength(contents));

    if (fileName.endsWith(PACKAGE_MANIFEST_FILE)) {
      observeEvidenceFile(fileName, contents, "manifest");
    }

    return contents;
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      throw error;
    }

    return undefined;
  }
};

const createBoundedModuleResolutionHost =
  function createBoundedModuleResolutionHost(
    allowedRoots: readonly string[],
    reserveOperations: (count?: number) => void,
    remainingBytes: () => number,
    reserveBytes: (count: number) => void,
    observeEvidenceFile: ObserveInstalledEvidenceFile
  ): ResolutionFileSystem & Pick<PackageDeclarationResolver, "canonicalPath"> {
    const canonicalAllowedRoots = allowedRoots.flatMap((root) => {
      reserveOperations();
      const canonicalRoot = canonicalEvidencePath(root);

      return canonicalRoot === undefined ? [] : [canonicalRoot];
    });

    const logicalAllowedRoots = [
      ...allowedRoots.map((root) => nodePath.resolve(root)),
      ...canonicalAllowedRoots,
    ];

    const directoryExistsCache = new Map<string, boolean>();
    const fileExistsCache = new Map<string, boolean>();
    const readFileCache = new Map<string, string | undefined>();
    const realpathCache = new Map<string, string | undefined>();

    const observedCanonicalPath = (fileName: string): string | undefined => {
      if (
        !isAuthorizedResolutionPath(
          canonicalAllowedRoots,
          logicalAllowedRoots,
          fileName
        )
      ) {
        return undefined;
      }

      return cachedResolutionResult(
        reserveOperations,
        realpathCache,
        fileName,
        () => canonicalEvidencePath(fileName)
      );
    };

    return {
      canonicalPath: observedCanonicalPath,
      directoryExists: (directory) =>
        isAuthorizedResolutionDirectory(
          canonicalAllowedRoots,
          logicalAllowedRoots,
          directory
        ) &&
        cachedResolutionResult(
          reserveOperations,
          directoryExistsCache,
          directory,
          () => isEvidenceDirectory(directory)
        ),
      fileExists: (fileName) =>
        isAuthorizedResolutionPath(
          canonicalAllowedRoots,
          logicalAllowedRoots,
          fileName
        ) &&
        cachedResolutionResult(
          reserveOperations,
          fileExistsCache,
          fileName,
          () => isEvidenceFile(fileName)
        ),
      getDirectories: () => [],
      readFile: (fileName): string | undefined => {
        if (
          !isAuthorizedResolutionPath(
            canonicalAllowedRoots,
            logicalAllowedRoots,
            fileName
          )
        ) {
          return undefined;
        }

        return cachedResolutionResult(
          reserveOperations,
          readFileCache,
          fileName,
          () =>
            readPackageResolutionFile(
              fileName,
              remainingBytes,
              reserveBytes,
              observeEvidenceFile
            )
        );
      },
      realpath: (fileName) => observedCanonicalPath(fileName) ?? fileName,
    };
  };

const startingDirectory = function startingDirectory(
  resolutionContext: string
): string {
  return isEvidenceDirectory(resolutionContext)
    ? resolutionContext
    : nodePath.dirname(resolutionContext);
};

const resolutionCompilerOptions = (): RawCompilerOptions => ({
  module: ModuleKind.NodeNext,
  moduleResolution: ModuleResolutionKind.NodeNext,
  noEmit: true,
  resolvePackageJsonExports: true,
  resolvePackageJsonImports: true,
});

const resolutionMode = (accessStyle: AccessStyle) =>
  accessStyle === "import" ? ModuleKind.ESNext : ModuleKind.CommonJS;

const isInspectableTypeScriptExtension = (extension: string): boolean =>
  /\.(?:[mc]?ts|tsx)$/u.test(extension);

const resolutionCapabilityRoots = function resolutionCapabilityRoots(
  roots: readonly string[]
): readonly string[] {
  return [
    ...new Set(
      roots.flatMap((root) => {
        const canonicalRoot = canonicalEvidencePath(root);

        return canonicalRoot === undefined
          ? []
          : [nodePath.resolve(root), canonicalRoot];
      })
    ),
  ];
};

/** Shares filesystem reads, resolution caches, and work budgets across one inspection. */
export const createCompilerWorkSession = function createCompilerWorkSession({
  evidenceObserver,
  operations = INSPECTION_BUDGET_POLICY.compilerHostOperations,
  resolutionBytes = DEFAULT_COMPILER_RESOLUTION_BYTES,
}: CompilerWorkLimits = {}): CompilerWorkSession {
  const observeEvidenceDirectory = evidenceObserver?.observeDirectory;
  const observeEvidenceFile = evidenceObserver?.observeFile ?? constVoid;
  const observeResolution = evidenceObserver?.observeResolution ?? constVoid;
  const packageManifestCache = new Map<string, Schema.JsonObject>();

  const replayHosts = new Map<
    string,
    ReturnType<typeof createBoundedModuleResolutionHost>
  >();

  let native: CompilerSession | undefined;

  const nativeSession = (): CompilerSession =>
    (native ??= new CompilerSession());

  const resolvers = new Map<string, ModuleResolver>();
  const resolvedModules = new Map<string, ResolvedModule | undefined>();
  const fileFormats = new Map<string, AccessStyle>();

  let operationCount = 0;
  let resolutionByteCount = 0;

  const remainingBytes = (): number =>
    Math.max(0, resolutionBytes - resolutionByteCount);

  const reserveBytes = (count: number): void => {
    resolutionByteCount += count;

    if (resolutionByteCount > resolutionBytes) {
      throw new InspectionLimitError(
        COMPILER_HOST_BYTES,
        COMPILER_BYTES_LIMIT_MESSAGE
      );
    }
  };

  const reserveOperations = (count = 1): void => {
    operationCount += count;

    if (operationCount > operations) {
      throw new InspectionLimitError(
        "compiler-host-work",
        "Inspection exceeded its compiler host work limit."
      );
    }
  };

  const readResolutionFile = (fileName: string): string => {
    const isManifest = fileName.endsWith(PACKAGE_MANIFEST_FILE);
    const availableBytes = remainingBytes();

    const manifestLimitApplies =
      isManifest && availableBytes >= MAX_MANIFEST_BYTES;

    const contents = readBoundedUtf8File(
      fileName,
      manifestLimitApplies ? MAX_MANIFEST_BYTES : availableBytes,
      manifestLimitApplies ? "package-manifest-bytes" : COMPILER_HOST_BYTES,
      manifestLimitApplies
        ? "Inspection exceeded its package manifest size limit."
        : COMPILER_BYTES_LIMIT_MESSAGE
    );

    reserveBytes(Buffer.byteLength(contents));

    if (isManifest) {
      observeEvidenceFile(fileName, contents, "manifest");
    }

    return contents;
  };

  const readManifest = (packageRoot: string): Schema.JsonObject | undefined => {
    const manifestPath = nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE);
    const cachedManifest = packageManifestCache.get(manifestPath);

    if (cachedManifest !== undefined) {
      return cachedManifest;
    }

    reserveOperations();
    const manifest = parseManifest(readResolutionFile(manifestPath));

    if (manifest !== undefined) {
      packageManifestCache.set(manifestPath, manifest);
    }

    return manifest;
  };

  const replayHost = (fileName: string, allowedRoots: readonly string[]) => {
    const contextDirectory = nodePath.dirname(fileName);
    const key = JSON.stringify([contextDirectory, allowedRoots]);
    let host = replayHosts.get(key);

    if (host === undefined) {
      host = createBoundedModuleResolutionHost(
        allowedRoots,
        reserveOperations,
        remainingBytes,
        reserveBytes,
        observeEvidenceFile
      );
      replayHosts.set(key, host);
    }

    return host;
  };

  const resolveModule = (
    specifier: string,
    containingFile: string,
    allowedRoots: readonly string[],
    accessStyle: AccessStyle
  ): ResolvedModule | undefined => {
    reserveOperations();
    const host = replayHost(containingFile, allowedRoots);

    const key = JSON.stringify([
      nodePath.dirname(containingFile),
      allowedRoots,
    ]);

    const session: CompilerSession = nativeSession();

    if (resolvedModules.size >= 4096) {
      resolvedModules.clear();
    }

    return cachedCompilerLookup(
      resolvedModules,
      JSON.stringify([key, specifier, accessStyle]),
      () =>
        session.withFileSystem(host, () => {
          let resolver = resolvers.get(key);

          if (resolver === undefined) {
            resolver = session.api.createModuleResolver(
              resolutionCompilerOptions()
            );
            resolvers.set(key, resolver);
          }

          return (
            resolver.resolveModuleName(
              specifier,
              nodePath.dirname(containingFile),
              resolutionMode(accessStyle)
            ).resolvedModule ?? undefined
          );
        })
    );
  };

  const resolveProbe = (
    probe: InstalledEvidenceResolutionProbe,
    allowedRoots: readonly string[]
  ): string | undefined => {
    const candidates =
      probe.kind === "module"
        ? [probe.specifier]
        : [
            ...new Set([
              `@types/${probe.specifier.replace(/^@/u, "").replace("/", "__")}`,
              probe.specifier,
            ]),
          ];

    for (const specifier of candidates) {
      const result = resolveModule(
        specifier,
        probe.containingFile,
        allowedRoots,
        probe.accessStyle ?? "import"
      );

      if (result !== undefined) {
        return replayHost(probe.containingFile, allowedRoots).canonicalPath(
          result.resolvedFileName
        );
      }
    }

    return undefined;
  };

  return {
    createPackageResolver: (resolutionContext, accessStyle, allowedRoots) => {
      const contextDirectory = startingDirectory(resolutionContext);

      const containingFile = nodePath.join(
        contextDirectory,
        accessStyle === "import"
          ? "__typepeek_resolution__.mts"
          : "__typepeek_resolution__.cts"
      );

      const host = replayHost(containingFile, allowedRoots);

      return {
        canonicalPath: host.canonicalPath,
        conditions: new Set([accessStyle, "types", "node"]),
        resolve: (specifier) => {
          const resolution = resolveModule(
            specifier,
            containingFile,
            allowedRoots,
            accessStyle
          );

          const resolvedPath =
            resolution !== undefined &&
            isInspectableTypeScriptExtension(resolution.extension)
              ? resolution.resolvedFileName
              : undefined;

          observeResolution({
            accessStyle,
            allowedRoots: resolutionCapabilityRoots(allowedRoots),
            containingFile,
            kind: "module",
            ...(resolvedPath !== undefined && { resolvedPath }),
            specifier,
          });

          return resolvedPath;
        },
      };
    },
    get native() {
      return nativeSession();
    },
    packageBoundaryObserver: {
      observeEvidenceFilePresence:
        evidenceObserver?.observeFilePresence ?? constVoid,
      readManifest,
      reserveOperation: reserveOperations,
    },
    readEvidenceFileFormat: (
      fileName,
      allowedRoots
    ): AccessStyle | undefined => {
      reserveOperations();

      if (/\.[mc]ts$/u.test(fileName)) {
        return fileName.endsWith(".mts") ? "import" : "require";
      }

      const sourceDirectory = nodePath.dirname(fileName);

      const formatKey = JSON.stringify([
        sourceDirectory,
        allowedRoots.filter((root) => isPathWithin(root, fileName)),
      ]);

      const cachedFormat = fileFormats.get(formatKey);

      if (cachedFormat !== undefined) {
        return cachedFormat;
      }

      const host = replayHost(fileName, allowedRoots);

      for (let directory = nodePath.dirname(fileName); ;) {
        const manifest = host.readFile(
          nodePath.join(directory, PACKAGE_MANIFEST_FILE)
        );

        if (manifest !== undefined) {
          const value = decodeJson(
            Schema.Struct({ type: Schema.optionalKey(Schema.String) }),
            manifest
          );

          const format = value.type === "module" ? "import" : "require";
          fileFormats.set(formatKey, format);

          return format;
        }

        const parent = nodePath.dirname(directory);

        if (parent === directory) {
          fileFormats.set(formatKey, "require");

          return "require";
        }

        directory = parent;
      }
    },
    readResolutionFile,
    ...(observeEvidenceDirectory !== undefined && { observeEvidenceDirectory }),
    observeEvidenceFile,
    observeResolution,
    reserveOperations,
    resolveEvidenceProbe: (probe, allowedRoots) => {
      reserveOperations();

      return resolveProbe(probe, allowedRoots);
    },
    resolveModule,
  };
};
