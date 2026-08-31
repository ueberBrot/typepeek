import ts from "@typescript/typescript6";
import { dirname, join, relative, resolve, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
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

const DEFAULT_COMPILER_HOST_OPERATIONS = 50_000;
const DEFAULT_COMPILER_RESOLUTION_BYTES = 8 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 256 * 1_024;

export interface PackageDeclarationResolver {
  readonly canonicalPath: (fileName: string) => string | undefined;
  readonly conditions: ReadonlySet<string>;
  readonly resolve: (specifier: string) => string | undefined;
}

interface TypeScriptInternals {
  readonly getConditions?: (
    options: ts.CompilerOptions,
    resolutionMode: ts.ResolutionMode,
  ) => readonly string[];
}

const typescriptInternals = ts as typeof ts & TypeScriptInternals;

export interface CompilerWorkSession {
  readonly createPackageResolver: (
    resolutionContext: string,
    accessStyle: AccessStyle,
    allowedRoots: readonly string[],
  ) => PackageDeclarationResolver;
  readonly packageBoundaryObserver: PackageBoundaryObserver;
  readonly readResolutionFile: (fileName: string) => string;
  readonly observeEvidenceFile: ObserveInstalledEvidenceFile;
  readonly observeEvidenceDirectory?: ObserveInstalledEvidenceDirectory;
  readonly observeResolution: (probe: InstalledEvidenceResolutionProbe) => void;
  readonly resolveEvidenceProbe: (
    probe: InstalledEvidenceResolutionProbe,
    allowedRoots: readonly string[],
  ) => string | undefined;
  readonly reserveOperations: (count?: number) => void;
}

export interface CompilerWorkLimits {
  readonly evidenceObserver?: InstalledEvidenceObserver;
  readonly operations?: number;
  readonly resolutionBytes?: number;
}

/** Owns one inspection's aggregate compiler work, bounded reads, and package resolution caches. */
export function createCompilerWorkSession({
  evidenceObserver,
  operations = DEFAULT_COMPILER_HOST_OPERATIONS,
  resolutionBytes = DEFAULT_COMPILER_RESOLUTION_BYTES,
}: CompilerWorkLimits = {}): CompilerWorkSession {
  const observeEvidenceDirectory = evidenceObserver?.observeDirectory;
  const observeEvidenceFile = evidenceObserver?.observeFile ?? (() => undefined);
  const observeResolution = evidenceObserver?.observeResolution ?? (() => undefined);
  const packageManifestCache = new Map<string, Readonly<Record<string, unknown>>>();
  let operationCount = 0;
  let resolutionByteCount = 0;

  const remainingBytes = (): number => Math.max(0, resolutionBytes - resolutionByteCount);
  const reserveBytes = (count: number): void => {
    resolutionByteCount += count;
    if (resolutionByteCount > resolutionBytes) {
      throw new InspectionLimitError(
        "compiler-host-bytes",
        "Inspection exceeded its compiler host byte limit.",
      );
    }
  };
  const reserveOperations = (count = 1): void => {
    operationCount += count;
    if (operationCount > operations) {
      throw new InspectionLimitError(
        "compiler-host-work",
        "Inspection exceeded its compiler host work limit.",
      );
    }
  };
  const readResolutionFile = (fileName: string): string => {
    const contents = readBoundedUtf8File(
      fileName,
      remainingBytes(),
      "compiler-host-bytes",
      "Inspection exceeded its compiler host byte limit.",
    );
    reserveBytes(Buffer.byteLength(contents));
    if (fileName.endsWith("package.json")) {
      observeEvidenceFile(fileName, contents, "manifest");
    }
    return contents;
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
        observeResolution,
      ),
    packageBoundaryObserver: {
      manifestCache: packageManifestCache,
      observeEvidenceFile,
      remainingBytes,
      reserveBytes,
      reserveOperation: reserveOperations,
    },
    readResolutionFile,
    ...(observeEvidenceDirectory === undefined ? {} : { observeEvidenceDirectory }),
    observeEvidenceFile,
    observeResolution,
    resolveEvidenceProbe: (probe, allowedRoots) =>
      resolveEvidenceProbe(
        probe,
        allowedRoots,
        reserveOperations,
        remainingBytes,
        reserveBytes,
        observeEvidenceFile,
      ),
    reserveOperations,
  };
}

function resolveEvidenceProbe(
  probe: InstalledEvidenceResolutionProbe,
  allowedRoots: readonly string[],
  reserveOperations: (count?: number) => void,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
  observeEvidenceFile: ObserveInstalledEvidenceFile,
): string | undefined {
  const host = createBoundedModuleResolutionHost(
    dirname(probe.containingFile),
    allowedRoots,
    reserveOperations,
    remainingBytes,
    reserveBytes,
    observeEvidenceFile,
  );
  const compilerOptions = resolutionCompilerOptions();
  const resolvedPath =
    probe.kind === "module"
      ? ts.resolveModuleName(
          probe.specifier,
          probe.containingFile,
          compilerOptions,
          host,
          undefined,
          undefined,
          resolutionMode(probe.accessStyle ?? "import"),
        ).resolvedModule?.resolvedFileName
      : ts.resolveTypeReferenceDirective(
          probe.specifier,
          probe.containingFile,
          compilerOptions,
          host,
        ).resolvedTypeReferenceDirective?.resolvedFileName;
  return resolvedPath === undefined ? undefined : host.canonicalPath(resolvedPath);
}

function createPackageDeclarationResolver(
  resolutionContext: string,
  accessStyle: AccessStyle,
  allowedRoots: readonly string[],
  reserveOperations: (count?: number) => void,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
  observeEvidenceFile: ObserveInstalledEvidenceFile,
  observeResolution: (probe: InstalledEvidenceResolutionProbe) => void,
): PackageDeclarationResolver {
  reserveOperations();
  const contextDirectory = startingDirectory(resolutionContext);
  const containingFile = join(
    contextDirectory,
    accessStyle === "import" ? "__typepeek_resolution__.mts" : "__typepeek_resolution__.cts",
  );
  const compilerOptions = resolutionCompilerOptions();
  const host = createBoundedModuleResolutionHost(
    contextDirectory,
    allowedRoots,
    reserveOperations,
    remainingBytes,
    reserveBytes,
    observeEvidenceFile,
  );
  const moduleResolutionCache = ts.createModuleResolutionCache(
    contextDirectory,
    (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
    compilerOptions,
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
        resolutionMode(accessStyle),
      );
      const resolvedPath = isInspectableTypeScriptResolution(resolution.resolvedModule)
        ? resolution.resolvedModule.resolvedFileName
        : undefined;
      observeResolution({
        accessStyle,
        allowedRoots: resolutionCapabilityRoots(allowedRoots),
        containingFile,
        kind: "module",
        ...(resolvedPath === undefined ? {} : { resolvedPath }),
        specifier,
      });
      return resolvedPath;
    },
  };
}

function resolutionCapabilityRoots(roots: readonly string[]): readonly string[] {
  return [
    ...new Set(
      roots.flatMap((root) => {
        const canonicalRoot = canonicalEvidencePath(root);
        return canonicalRoot === undefined ? [] : [resolve(root), canonicalRoot];
      }),
    ),
  ];
}

function createBoundedModuleResolutionHost(
  contextDirectory: string,
  allowedRoots: readonly string[],
  reserveOperations: (count?: number) => void,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
  observeEvidenceFile: ObserveInstalledEvidenceFile,
): ts.ModuleResolutionHost & Pick<PackageDeclarationResolver, "canonicalPath"> {
  const canonicalAllowedRoots = allowedRoots.flatMap((root) => {
    reserveOperations();
    const canonicalRoot = canonicalEvidencePath(root);
    return canonicalRoot === undefined ? [] : [canonicalRoot];
  });
  const logicalAllowedRoots = [
    ...allowedRoots.map((root) => resolve(root)),
    ...canonicalAllowedRoots,
  ];
  const directoryExistsCache = new Map<string, boolean>();
  const fileExistsCache = new Map<string, boolean>();
  const readFileCache = new Map<string, string | undefined>();
  const realpathCache = new Map<string, string | undefined>();
  const observedCanonicalPath = (fileName: string): string | undefined => {
    if (!isAuthorizedResolutionPath(canonicalAllowedRoots, logicalAllowedRoots, fileName)) {
      return undefined;
    }
    return cachedResolutionResult(reserveOperations, realpathCache, fileName, () =>
      canonicalEvidencePath(fileName),
    );
  };
  return {
    canonicalPath: observedCanonicalPath,
    directoryExists: (directory) =>
      isAuthorizedResolutionDirectory(canonicalAllowedRoots, logicalAllowedRoots, directory) &&
      cachedResolutionResult(reserveOperations, directoryExistsCache, directory, () =>
        isEvidenceDirectory(directory),
      ),
    fileExists: (fileName) =>
      isAuthorizedResolutionPath(canonicalAllowedRoots, logicalAllowedRoots, fileName) &&
      cachedResolutionResult(reserveOperations, fileExistsCache, fileName, () =>
        isEvidenceFile(fileName),
      ),
    getCurrentDirectory: () => contextDirectory,
    readFile: (fileName) => {
      if (!isAuthorizedResolutionPath(canonicalAllowedRoots, logicalAllowedRoots, fileName)) {
        return undefined;
      }
      return cachedResolutionResult(reserveOperations, readFileCache, fileName, () =>
        readPackageResolutionFile(fileName, remainingBytes, reserveBytes, observeEvidenceFile),
      );
    },
    realpath: (fileName) => observedCanonicalPath(fileName) ?? fileName,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

function isAuthorizedResolutionPath(
  canonicalAllowedRoots: readonly string[],
  logicalAllowedRoots: readonly string[],
  candidate: string,
): boolean {
  return isAuthorizedResolutionCandidate(
    canonicalAllowedRoots,
    logicalAllowedRoots,
    candidate,
    false,
  );
}

function isAuthorizedResolutionDirectory(
  canonicalAllowedRoots: readonly string[],
  logicalAllowedRoots: readonly string[],
  candidate: string,
): boolean {
  return isAuthorizedResolutionCandidate(
    canonicalAllowedRoots,
    logicalAllowedRoots,
    candidate,
    true,
  );
}

function isAuthorizedResolutionCandidate(
  canonicalAllowedRoots: readonly string[],
  logicalAllowedRoots: readonly string[],
  candidate: string,
  allowAncestor: boolean,
): boolean {
  const lexicalCandidate = resolve(candidate);
  if (
    !logicalAllowedRoots.some(
      (allowedRoot) =>
        isPathWithin(allowedRoot, lexicalCandidate) ||
        (allowAncestor && isPathWithin(lexicalCandidate, allowedRoot)),
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
        (allowAncestor && isPathWithin(canonicalCandidate, allowedRoot)),
    ) ||
      (allowAncestor &&
        logicalAllowedRoots.some((allowedRoot) => isPathWithin(lexicalCandidate, allowedRoot))))
  );
}

function crossesNestedPackageBoundary(allowedRoot: string, candidate: string): boolean {
  const segments = relative(allowedRoot, candidate).split(sep);
  for (const [index, segment] of segments.entries()) {
    if (segment !== "node_modules") {
      continue;
    }
    const packageSegment = segments[index + 1];
    if (packageSegment === undefined) {
      return false;
    }
    return packageSegment.startsWith("@") ? segments[index + 2] !== undefined : true;
  }
  return false;
}

function cachedResolutionResult<Result>(
  reserveOperations: (count?: number) => void,
  cache: Map<string, Result>,
  key: string,
  read: () => Result,
): Result {
  reserveOperations();
  if (cache.has(key)) {
    return cache.get(key) as Result;
  }
  const result = read();
  cache.set(key, result);
  return result;
}

function readPackageResolutionFile(
  fileName: string,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
  observeEvidenceFile: ObserveInstalledEvidenceFile,
): string | undefined {
  try {
    const availableBytes = remainingBytes();
    const contents = readBoundedUtf8File(
      fileName,
      Math.min(MAX_MANIFEST_BYTES, availableBytes),
      availableBytes < MAX_MANIFEST_BYTES ? "compiler-host-bytes" : "package-manifest-bytes",
      availableBytes < MAX_MANIFEST_BYTES
        ? "Inspection exceeded its compiler host byte limit."
        : "Inspection exceeded its package manifest size limit.",
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
}

function resolutionCompilerOptions(): ts.CompilerOptions {
  return {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
  };
}

function resolutionMode(accessStyle: AccessStyle): ts.ResolutionMode {
  return accessStyle === "import" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
}

function resolutionConditions(
  compilerOptions: ts.CompilerOptions,
  accessStyle: AccessStyle,
): ReadonlySet<string> {
  const getConditions = typescriptInternals.getConditions;
  if (getConditions === undefined) {
    throw new UnsupportedInspectionError(
      "The TypeScript compiler cannot select package export conditions.",
    );
  }
  return new Set(getConditions(compilerOptions, resolutionMode(accessStyle)));
}

function isInspectableTypeScriptResolution(
  resolvedModule: ts.ResolvedModuleFull | undefined,
): resolvedModule is ts.ResolvedModuleFull {
  return resolvedModule !== undefined && isInspectableTypeScriptExtension(resolvedModule.extension);
}

function isInspectableTypeScriptExtension(extension: string): boolean {
  return [
    ts.Extension.Ts,
    ts.Extension.Tsx,
    ts.Extension.Mts,
    ts.Extension.Cts,
    ts.Extension.Dts,
    ts.Extension.Dmts,
    ts.Extension.Dcts,
  ].includes(extension as ts.Extension);
}

function startingDirectory(resolutionContext: string): string {
  return isEvidenceDirectory(resolutionContext) ? resolutionContext : dirname(resolutionContext);
}
