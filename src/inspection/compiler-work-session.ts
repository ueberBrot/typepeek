import ts from "@typescript/typescript6";
import { dirname, join } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  canonicalEvidencePath,
  isEvidenceDirectory,
  isEvidenceFile,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence-boundary";
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
  ) => PackageDeclarationResolver;
  readonly observePackageBoundary: (
    manifestCache: Map<string, Readonly<Record<string, unknown>>>,
  ) => PackageBoundaryObserver;
  readonly readResolutionFile: (fileName: string) => string;
  readonly reserveOperations: (count?: number) => void;
}

export interface CompilerWorkLimits {
  readonly operations?: number;
  readonly resolutionBytes?: number;
}

/** Owns one inspection's aggregate compiler work, bounded reads, and package resolution caches. */
export function createCompilerWorkSession({
  operations = DEFAULT_COMPILER_HOST_OPERATIONS,
  resolutionBytes = DEFAULT_COMPILER_RESOLUTION_BYTES,
}: CompilerWorkLimits = {}): CompilerWorkSession {
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
    return contents;
  };

  return {
    createPackageResolver: (resolutionContext, accessStyle) =>
      createPackageDeclarationResolver(
        resolutionContext,
        accessStyle,
        reserveOperations,
        remainingBytes,
        reserveBytes,
      ),
    observePackageBoundary: (manifestCache) => ({
      manifestCache,
      remainingBytes,
      reserveBytes,
      reserveOperation: reserveOperations,
    }),
    readResolutionFile,
    reserveOperations,
  };
}

function createPackageDeclarationResolver(
  resolutionContext: string,
  accessStyle: AccessStyle,
  reserveOperations: (count?: number) => void,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
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
    reserveOperations,
    remainingBytes,
    reserveBytes,
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
      return isInspectableTypeScriptResolution(resolution.resolvedModule)
        ? resolution.resolvedModule.resolvedFileName
        : undefined;
    },
  };
}

function createBoundedModuleResolutionHost(
  contextDirectory: string,
  reserveOperations: (count?: number) => void,
  remainingBytes: () => number,
  reserveBytes: (count: number) => void,
): ts.ModuleResolutionHost & Pick<PackageDeclarationResolver, "canonicalPath"> {
  const directoryExistsCache = new Map<string, boolean>();
  const fileExistsCache = new Map<string, boolean>();
  const readFileCache = new Map<string, string | undefined>();
  const realpathCache = new Map<string, string | undefined>();
  const observedCanonicalPath = (fileName: string): string | undefined =>
    cachedResolutionResult(reserveOperations, realpathCache, fileName, () =>
      canonicalEvidencePath(fileName),
    );
  return {
    canonicalPath: observedCanonicalPath,
    directoryExists: (directory) =>
      cachedResolutionResult(reserveOperations, directoryExistsCache, directory, () =>
        isEvidenceDirectory(directory),
      ),
    fileExists: (fileName) =>
      cachedResolutionResult(reserveOperations, fileExistsCache, fileName, () =>
        isEvidenceFile(fileName),
      ),
    getCurrentDirectory: () => contextDirectory,
    readFile: (fileName) =>
      cachedResolutionResult(reserveOperations, readFileCache, fileName, () =>
        readPackageResolutionFile(fileName, remainingBytes, reserveBytes),
      ),
    realpath: (fileName) => observedCanonicalPath(fileName) ?? fileName,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
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
