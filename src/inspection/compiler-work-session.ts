import nodePath from "node:path";

import ts from "@typescript/typescript6";
import type { Schema } from "effect";
import { constVoid } from "effect/Function";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import { cachedCompilerLookup } from "#typepeek/inspection/compiler-cache";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
  isEvidenceDirectory,
  isEvidenceFile,
  isPathWithin,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence-boundary";
import type {
  InstalledEvidenceObserver,
  InstalledEvidenceResolutionProbe,
  ObserveInstalledEvidenceDirectory,
  ObserveInstalledEvidenceFile,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import type { PackageBoundaryObserver } from "#typepeek/inspection/installed-package-boundary";
import type { AccessStyle } from "#typepeek/inspection/protocol";

const COMPILER_HOST_BYTES = "compiler-host-bytes";

const COMPILER_BYTES_LIMIT_MESSAGE =
  "Inspection exceeded its compiler host byte limit.";

const DEFAULT_COMPILER_RESOLUTION_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface PackageDeclarationResolver {
  readonly canonicalPath: (fileName: string) => string | undefined;
  readonly conditions: ReadonlySet<string>;
  readonly resolve: (specifier: string) => string | undefined;
}

interface TypeScriptInternals {
  readonly getConditions?: (
    options: ts.CompilerOptions,
    resolutionMode: ts.ResolutionMode
  ) => readonly string[];
}

const typescriptInternals: typeof ts & TypeScriptInternals = ts;

export interface CompilerWorkSession {
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

    if (fileName.endsWith("package.json")) {
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
    contextDirectory: string,
    allowedRoots: readonly string[],
    reserveOperations: (count?: number) => void,
    remainingBytes: () => number,
    reserveBytes: (count: number) => void,
    observeEvidenceFile: ObserveInstalledEvidenceFile
  ): ts.ModuleResolutionHost &
    Pick<PackageDeclarationResolver, "canonicalPath"> {
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
      getCurrentDirectory: () => contextDirectory,
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
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    };
  };

const startingDirectory = function startingDirectory(
  resolutionContext: string
): string {
  return isEvidenceDirectory(resolutionContext)
    ? resolutionContext
    : nodePath.dirname(resolutionContext);
};

const resolutionCompilerOptions =
  function resolutionCompilerOptions(): ts.CompilerOptions {
    return {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      resolvePackageJsonExports: true,
      resolvePackageJsonImports: true,
    };
  };

const resolutionMode = function resolutionMode(
  accessStyle: AccessStyle
): ts.ResolutionMode {
  return accessStyle === "import"
    ? ts.ModuleKind.ESNext
    : ts.ModuleKind.CommonJS;
};

const resolutionConditions = function resolutionConditions(
  compilerOptions: ts.CompilerOptions,
  accessStyle: AccessStyle
): ReadonlySet<string> {
  const { getConditions } = typescriptInternals;

  if (getConditions === undefined) {
    throw new UnsupportedInspectionError(
      "The TypeScript compiler cannot select package export conditions."
    );
  }

  return new Set(getConditions(compilerOptions, resolutionMode(accessStyle)));
};

const INSPECTABLE_TYPESCRIPT_EXTENSIONS = new Set<string>([
  ts.Extension.Ts,
  ts.Extension.Tsx,
  ts.Extension.Mts,
  ts.Extension.Cts,
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
]);

const isInspectableTypeScriptExtension = (extension: string): boolean =>
  INSPECTABLE_TYPESCRIPT_EXTENSIONS.has(extension);

const isInspectableTypeScriptResolution =
  function isInspectableTypeScriptResolution(
    resolvedModule: ts.ResolvedModuleFull | undefined
  ): resolvedModule is ts.ResolvedModuleFull {
    return (
      resolvedModule !== undefined &&
      isInspectableTypeScriptExtension(resolvedModule.extension)
    );
  };

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

const createPackageDeclarationResolver =
  function createPackageDeclarationResolver(
    resolutionContext: string,
    accessStyle: AccessStyle,
    allowedRoots: readonly string[],
    reserveOperations: (count?: number) => void,
    remainingBytes: () => number,
    reserveBytes: (count: number) => void,
    observeEvidenceFile: ObserveInstalledEvidenceFile,
    observeResolution: (probe: InstalledEvidenceResolutionProbe) => void
  ): PackageDeclarationResolver {
    reserveOperations();
    const contextDirectory = startingDirectory(resolutionContext);

    const containingFile = nodePath.join(
      contextDirectory,
      accessStyle === "import"
        ? "__typepeek_resolution__.mts"
        : "__typepeek_resolution__.cts"
    );

    const compilerOptions = resolutionCompilerOptions();

    const host = createBoundedModuleResolutionHost(
      contextDirectory,
      allowedRoots,
      reserveOperations,
      remainingBytes,
      reserveBytes,
      observeEvidenceFile
    );

    const moduleResolutionCache = ts.createModuleResolutionCache(
      contextDirectory,
      (fileName) =>
        ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
      compilerOptions
    );

    return {
      canonicalPath: host.canonicalPath,
      conditions: resolutionConditions(compilerOptions, accessStyle),
      resolve: (specifier) => {
        reserveOperations();

        const resolution = ts.resolveModuleName(
          specifier,
          containingFile,
          compilerOptions,
          host,
          moduleResolutionCache,
          undefined,
          resolutionMode(accessStyle)
        );

        const resolvedPath = isInspectableTypeScriptResolution(
          resolution.resolvedModule
        )
          ? resolution.resolvedModule.resolvedFileName
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
  };

const resolveEvidenceProbe = function resolveEvidenceProbe(
  probe: InstalledEvidenceResolutionProbe,
  host: ReturnType<typeof createBoundedModuleResolutionHost>
): string | undefined {
  const compilerOptions = resolutionCompilerOptions();

  const typeReferenceMode =
    probe.accessStyle === undefined
      ? undefined
      : resolutionMode(probe.accessStyle);

  const resolvedPath =
    probe.kind === "module"
      ? ts.resolveModuleName(
          probe.specifier,
          probe.containingFile,
          compilerOptions,
          host,
          undefined,
          undefined,
          resolutionMode(probe.accessStyle ?? "import")
        ).resolvedModule?.resolvedFileName
      : ts.resolveTypeReferenceDirective(
          probe.specifier,
          probe.containingFile,
          compilerOptions,
          host,
          undefined,
          undefined,
          typeReferenceMode
        ).resolvedTypeReferenceDirective?.resolvedFileName;

  return resolvedPath === undefined
    ? undefined
    : host.canonicalPath(resolvedPath);
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
    const isManifest = fileName.endsWith("package.json");
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

  const replayHost = (fileName: string, allowedRoots: readonly string[]) => {
    const contextDirectory = nodePath.dirname(fileName);
    const key = JSON.stringify([contextDirectory, allowedRoots]);
    let host = replayHosts.get(key);

    if (host === undefined) {
      host = createBoundedModuleResolutionHost(
        contextDirectory,
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

  return {
    createPackageResolver: (resolutionContext, accessStyle, allowedRoots) =>
      createPackageDeclarationResolver(
        resolutionContext,
        accessStyle,
        allowedRoots,
        reserveOperations,
        remainingBytes,
        reserveBytes,
        observeEvidenceFile,
        observeResolution
      ),
    packageBoundaryObserver: {
      manifestCache: packageManifestCache,
      observeEvidenceFile,
      observeEvidenceFilePresence:
        evidenceObserver?.observeFilePresence ?? constVoid,
      remainingBytes,
      reserveBytes,
      reserveOperation: reserveOperations,
    },
    readEvidenceFileFormat: (
      fileName,
      allowedRoots
    ): AccessStyle | undefined => {
      reserveOperations();

      const mode = ts.getImpliedNodeFormatForFile(
        fileName,
        undefined,
        replayHost(fileName, allowedRoots),
        resolutionCompilerOptions()
      );

      if (mode === undefined) {
        return undefined;
      }

      if (mode === ts.ModuleKind.CommonJS) {
        return "require";
      }

      return "import";
    },
    readResolutionFile,
    ...(observeEvidenceDirectory !== undefined && { observeEvidenceDirectory }),
    observeEvidenceFile,
    observeResolution,
    reserveOperations,
    resolveEvidenceProbe: (probe, allowedRoots) => {
      reserveOperations();

      return resolveEvidenceProbe(
        probe,
        replayHost(probe.containingFile, allowedRoots)
      );
    },
  };
};
