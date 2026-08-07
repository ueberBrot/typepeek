import ts from "@typescript/typescript6";
import {
  closeSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  type AccessStyle,
  type NormalizedInspectionTarget,
  type PublicSubpath,
} from "#typepeek/inspection/protocol";

const MAX_EXPORT_TARGET_DEPTH = 32;
const MAX_EXPORT_TARGET_NODES = 1_024;
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_PUBLIC_SUBPATHS = 200;
const MAX_PUBLIC_SUBPATH_FILE_DEPTH = 64;
const MAX_PUBLIC_SUBPATH_FILE_ENTRIES = 4_096;

interface ResolutionVariantSelection {
  readonly request: NormalizedInspectionTarget;
  readonly packageRoot: string;
  readonly packageRootSpecifier: string;
  readonly subpathKey?: string;
  readonly exports: unknown;
}

interface SelectedResolutionVariant {
  readonly declarationPath: string;
  readonly readPublicSubpaths: () => readonly PublicSubpath[];
}

interface ExportTargetTraversal {
  readonly blockingTargets: WeakMap<object, boolean>;
  controlNodes: number;
  nodes: number;
}

interface PackageDirectory {
  readonly canonicalAncestors: ReadonlySet<string>;
  readonly canonicalDirectory: string;
  readonly depth: number;
  readonly logicalDirectory: string;
}

interface PackageEntry {
  readonly canonicalPath: string;
  readonly kind: "directory" | "file";
  readonly logicalPath: string;
}

interface PackageSearchRoot {
  readonly canonicalDirectory: string;
  readonly logicalDirectory: string;
}

interface TypeScriptInternals {
  readonly getConditions?: (
    options: ts.CompilerOptions,
    resolutionMode: ts.ResolutionMode,
  ) => readonly string[];
  readonly Version?: new (value: string) => unknown;
  readonly VersionRange?: {
    readonly tryParse: (
      range: string,
    ) => { readonly test: (version: unknown) => boolean } | undefined;
  };
}

type ResolutionConditions = ReadonlySet<string>;

const typescriptInternals = ts as typeof ts & TypeScriptInternals;

/**
 * Selects one declaration entrypoint and the exact Public Subpaths exposed by
 * the same Resolution Context and Access Style. Manifest and filesystem
 * traversal are bounded and package targets never escape the installed package.
 */
export function selectResolutionVariant({
  request,
  packageRoot,
  packageRootSpecifier,
  subpathKey,
  exports,
}: ResolutionVariantSelection): SelectedResolutionVariant {
  assertPublicSubpath(subpathKey, exports);
  return {
    declarationPath: resolveDeclarationPath(
      request.resolutionContext,
      request.specifier,
      packageRoot,
      request.accessStyle,
    ),
    readPublicSubpaths: () =>
      subpathKey === undefined
        ? publicSubpathSpecifiers(packageRootSpecifier, exports, request, packageRoot)
        : [],
  };
}

function assertPublicSubpath(subpathKey: string | undefined, exports: unknown): void {
  if (
    subpathKey !== undefined &&
    !publicSubpathKeys(exports).some((candidate) => publicSubpathKeyMatches(candidate, subpathKey))
  ) {
    throw new UnsupportedInspectionError(
      "The requested Specifier is not a manifest-declared Public Subpath.",
    );
  }
}

function publicSubpathSpecifiers(
  packageRootSpecifier: string,
  exports: unknown,
  request: NormalizedInspectionTarget,
  packageRoot: string,
): readonly PublicSubpath[] {
  return publicSubpathCandidates(
    packageRootSpecifier,
    exports,
    packageRoot,
    request.accessStyle,
  ).flatMap((specifier) =>
    isResolvablePublicSubpath(specifier, request, packageRoot) ? [{ specifier }] : [],
  );
}

function publicSubpathCandidates(
  packageRootSpecifier: string,
  exports: unknown,
  packageRoot: string,
  accessStyle: AccessStyle,
): readonly string[] {
  const conditions = resolutionConditions(accessStyle);
  const subpathEntries = publicSubpathEntries(exports);
  assertPublicSubpathCount(subpathEntries.length);
  const targetTraversal: ExportTargetTraversal = {
    blockingTargets: new WeakMap(),
    controlNodes: 0,
    nodes: 0,
  };
  const fileTraversal = { entries: 0 };
  const candidateSpecifiers = new Set<string>();

  for (const [subpathKey, target] of subpathEntries) {
    for (const specifier of publicSubpathEntryCandidates(
      packageRootSpecifier,
      subpathKey,
      target,
      packageRoot,
      conditions,
      targetTraversal,
      fileTraversal,
    )) {
      candidateSpecifiers.add(specifier);
      assertPublicSubpathCount(candidateSpecifiers.size);
    }
  }

  return [...candidateSpecifiers].sort();
}

function publicSubpathEntryCandidates(
  packageRootSpecifier: string,
  subpathKey: string,
  target: unknown,
  packageRoot: string,
  conditions: ResolutionConditions,
  targetTraversal: ExportTargetTraversal,
  fileTraversal: { entries: number },
): readonly string[] {
  if (!subpathKey.includes("*")) {
    return [`${packageRootSpecifier}${subpathKey.slice(1)}`];
  }
  return exportTargetPatterns(target, conditions, targetTraversal).flatMap((targetPattern) =>
    packageTargetCaptures(packageRoot, targetPattern, fileTraversal).flatMap((capture) =>
      concretePublicSubpathSpecifier(packageRootSpecifier, subpathKey, capture),
    ),
  );
}

function concretePublicSubpathSpecifier(
  packageRootSpecifier: string,
  subpathKey: string,
  capture: string,
): readonly string[] {
  const concreteSubpathKey = subpathKey.replace("*", capture);
  return isSafeConcretePublicSubpathKey(concreteSubpathKey)
    ? [`${packageRootSpecifier}${concreteSubpathKey.slice(1)}`]
    : [];
}

function isResolvablePublicSubpath(
  specifier: string,
  request: NormalizedInspectionTarget,
  packageRoot: string,
): boolean {
  const declarationPath = resolvePackageDeclaration(
    request.resolutionContext,
    specifier,
    request.accessStyle,
  );
  const canonicalDeclarationPath =
    declarationPath === undefined ? undefined : canonicalPath(declarationPath);
  return (
    canonicalDeclarationPath !== undefined && isPathWithin(packageRoot, canonicalDeclarationPath)
  );
}

function assertPublicSubpathCount(count: number): void {
  if (count > MAX_PUBLIC_SUBPATHS) {
    throw new InspectionLimitError("Inspection exceeded its Public Subpath limit.");
  }
}

function exportTargetPatterns(
  target: unknown,
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal,
): readonly string[] {
  const patterns: string[] = [];
  const pending: { readonly target: unknown; readonly depth: number }[] = [{ target, depth: 0 }];

  while (pending.length > 0) {
    const candidate = pending.pop() as {
      readonly target: unknown;
      readonly depth: number;
    };
    reserveExportTargetNode(candidate.depth, traversal);
    const pattern = readExportTargetPattern(candidate.target);
    if (pattern !== undefined) {
      patterns.push(pattern);
      continue;
    }
    const children = exportTargetChildren(candidate.target, conditions, traversal);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        target: children[index],
        depth: candidate.depth + 1,
      });
    }
  }
  return patterns;
}

function readExportTargetPattern(target: unknown): string | undefined {
  return typeof target === "string" && isSafePackageTargetPattern(target) ? target : undefined;
}

function reserveExportTargetNode(depth: number, traversal: ExportTargetTraversal): void {
  traversal.nodes += 1;
  if (traversal.nodes > MAX_EXPORT_TARGET_NODES || depth > MAX_EXPORT_TARGET_DEPTH) {
    throw new InspectionLimitError(
      "Inspection exceeded its package export target traversal limit.",
    );
  }
}

function exportTargetChildren(
  target: unknown,
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal,
): readonly unknown[] {
  if (Array.isArray(target)) {
    return reachableFallbackTargets(target, conditions, traversal);
  }
  if (!isRecord(target)) {
    return [];
  }
  const applicableTargets = Object.entries(target).flatMap(([condition, child]) =>
    isApplicableExportCondition(condition, conditions) ? [child] : [],
  );
  return reachableFallbackTargets(applicableTargets, conditions, traversal);
}

function reachableFallbackTargets(
  targets: readonly unknown[],
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal,
): readonly unknown[] {
  const reachable: unknown[] = [];
  for (const target of targets) {
    reachable.push(target);
    if (definitelyBlocksFallback(target, conditions, traversal)) {
      break;
    }
  }
  return reachable;
}

function definitelyBlocksFallback(
  target: unknown,
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal,
  depth = 0,
): boolean {
  if (target === null) {
    return true;
  }
  if (!Array.isArray(target) && !isRecord(target)) {
    return false;
  }
  const cached = traversal.blockingTargets.get(target);
  if (cached !== undefined) {
    return cached;
  }
  reserveExportTargetControlNode(depth, traversal);
  const children = Array.isArray(target)
    ? target
    : Object.entries(target).flatMap(([condition, child]) =>
        isApplicableExportCondition(condition, conditions) ? [child] : [],
      );
  const blocks = children.some((child) =>
    definitelyBlocksFallback(child, conditions, traversal, depth + 1),
  );
  traversal.blockingTargets.set(target, blocks);
  return blocks;
}

function reserveExportTargetControlNode(depth: number, traversal: ExportTargetTraversal): void {
  traversal.controlNodes += 1;
  if (traversal.controlNodes > MAX_EXPORT_TARGET_NODES || depth > MAX_EXPORT_TARGET_DEPTH) {
    throw new InspectionLimitError(
      "Inspection exceeded its package export target traversal limit.",
    );
  }
}

function isApplicableExportCondition(condition: string, conditions: ResolutionConditions): boolean {
  return (
    condition === "default" ||
    conditions.has(condition) ||
    isApplicableVersionedTypesCondition(condition, conditions)
  );
}

function isApplicableVersionedTypesCondition(
  condition: string,
  conditions: ResolutionConditions,
): boolean {
  if (!conditions.has("types") || !condition.startsWith("types@")) {
    return false;
  }
  const { Version, VersionRange } = typescriptInternals;
  if (Version === undefined || VersionRange === undefined) {
    throw new UnsupportedInspectionError(
      "The TypeScript compiler cannot select versioned package export conditions.",
    );
  }
  const range = VersionRange.tryParse(condition.slice("types@".length));
  return range?.test(new Version(ts.version)) ?? false;
}

function resolutionConditions(accessStyle: AccessStyle): ResolutionConditions {
  const { getConditions } = typescriptInternals;
  if (getConditions === undefined) {
    throw new UnsupportedInspectionError(
      "The TypeScript compiler cannot select package export conditions.",
    );
  }
  return new Set(getConditions(resolutionCompilerOptions(), resolutionMode(accessStyle)));
}

function isSafePackageTargetPattern(target: string): boolean {
  if (!target.startsWith("./")) {
    return false;
  }
  const segments = target.slice(2).split("/");
  const wildcardCount = Array.from(target).filter((character) => character === "*").length;
  return wildcardCount === 1 && segments.length > 0 && segments.every(isSafePackagePathSegment);
}

function packageTargetCaptures(
  packageRoot: string,
  targetPattern: string,
  traversal: { entries: number },
): readonly string[] {
  const wildcardIndex = targetPattern.indexOf("*");
  const prefix = targetPattern.slice(0, wildcardIndex);
  const suffix = targetPattern.slice(wildcardIndex + 1);
  const searchRoot = join(packageRoot, dirname(prefix.slice(2)));
  return readBoundedPackageFiles(packageRoot, searchRoot, traversal)
    .flatMap((packageFile) => packageTargetCapture(packageRoot, packageFile, prefix, suffix))
    .sort();
}

function packageTargetCapture(
  packageRoot: string,
  packageFile: string,
  prefix: string,
  suffix: string,
): readonly string[] {
  const target = `./${relative(packageRoot, packageFile).split(sep).join("/")}`;
  return target.startsWith(prefix) &&
    target.endsWith(suffix) &&
    target.length >= prefix.length + suffix.length
    ? [target.slice(prefix.length, target.length - suffix.length)]
    : [];
}

function readBoundedPackageFiles(
  packageRoot: string,
  searchRoot: string,
  traversal: { entries: number },
): readonly string[] {
  const readableSearchRoot = readPackageSearchRoot(packageRoot, searchRoot);
  if (readableSearchRoot === undefined) {
    return [];
  }
  const files: string[] = [];
  const pending: PackageDirectory[] = [
    {
      canonicalAncestors: new Set([readableSearchRoot.canonicalDirectory]),
      canonicalDirectory: readableSearchRoot.canonicalDirectory,
      depth: 0,
      logicalDirectory: readableSearchRoot.logicalDirectory,
    },
  ];

  while (pending.length > 0) {
    const candidate = pending.pop() as PackageDirectory;
    if (candidate.depth > MAX_PUBLIC_SUBPATH_FILE_DEPTH) {
      throw new InspectionLimitError(
        "Inspection exceeded its Public Subpath file traversal depth limit.",
      );
    }
    const entries = readBoundedDirectoryEntries(candidate.canonicalDirectory, traversal).flatMap(
      (entry) => readPackageEntry(packageRoot, candidate.logicalDirectory, entry),
    );
    pending.push(
      ...entries
        .filter(
          (entry) =>
            entry.kind === "directory" && !candidate.canonicalAncestors.has(entry.canonicalPath),
        )
        .map((entry) => ({
          canonicalAncestors: new Set([...candidate.canonicalAncestors, entry.canonicalPath]),
          canonicalDirectory: entry.canonicalPath,
          depth: candidate.depth + 1,
          logicalDirectory: entry.logicalPath,
        }))
        .reverse(),
    );
    files.push(
      ...entries.filter((entry) => entry.kind === "file").map((entry) => entry.logicalPath),
    );
  }
  return files;
}

function readPackageSearchRoot(
  packageRoot: string,
  searchRoot: string,
): PackageSearchRoot | undefined {
  const canonicalSearchRoot = canonicalPath(searchRoot);
  return canonicalSearchRoot !== undefined &&
    isPathWithin(packageRoot, canonicalSearchRoot) &&
    isDirectory(canonicalSearchRoot)
    ? {
        canonicalDirectory: canonicalSearchRoot,
        logicalDirectory: searchRoot,
      }
    : undefined;
}

function readPackageEntry(
  packageRoot: string,
  logicalDirectory: string,
  entry: Dirent,
): readonly PackageEntry[] {
  const logicalPath = join(logicalDirectory, entry.name);
  const canonicalEntryPath = canonicalPath(logicalPath);
  if (canonicalEntryPath === undefined || !isPathWithin(packageRoot, canonicalEntryPath)) {
    return [];
  }
  if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(canonicalEntryPath))) {
    return [{ canonicalPath: canonicalEntryPath, kind: "directory", logicalPath }];
  }
  return entry.isFile() || (entry.isSymbolicLink() && isFile(canonicalEntryPath))
    ? [{ canonicalPath: canonicalEntryPath, kind: "file", logicalPath }]
    : [];
}

function readBoundedDirectoryEntries(
  directory: string,
  traversal: { entries: number },
): readonly Dirent[] {
  const entries: Dirent[] = [];
  const directoryHandle = opendirSync(directory);
  try {
    while (true) {
      const entry = directoryHandle.readSync();
      if (entry === null) {
        break;
      }
      traversal.entries += 1;
      if (traversal.entries > MAX_PUBLIC_SUBPATH_FILE_ENTRIES) {
        throw new InspectionLimitError(
          "Inspection exceeded its Public Subpath file traversal limit.",
        );
      }
      entries.push(entry);
    }
  } finally {
    directoryHandle.closeSync();
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function publicSubpathKeys(exports: unknown): readonly string[] {
  return publicSubpathEntries(exports).map(([subpathKey]) => subpathKey);
}

function publicSubpathEntries(
  exports: unknown,
): readonly (readonly [subpathKey: string, target: unknown])[] {
  return isRecord(exports)
    ? Object.entries(exports)
        .filter(([subpathKey, target]) => target !== null && isSafePublicSubpathKey(subpathKey))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    : [];
}

function isSafePublicSubpathKey(subpathKey: string): boolean {
  if (!subpathKey.startsWith("./")) {
    return false;
  }
  const segments = subpathKey.slice(2).split("/");
  const wildcardCount = Array.from(subpathKey).filter((character) => character === "*").length;
  return segments.length > 0 && segments.every(isSafePackagePathSegment) && wildcardCount <= 1;
}

function isSafeConcretePublicSubpathKey(subpathKey: string): boolean {
  return isSafePublicSubpathKey(subpathKey) && !subpathKey.includes("*");
}

function publicSubpathKeyMatches(pattern: string, subpathKey: string): boolean {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) {
    return pattern === subpathKey;
  }
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  return (
    subpathKey.startsWith(prefix) &&
    subpathKey.endsWith(suffix) &&
    subpathKey.length >= prefix.length + suffix.length
  );
}

function resolveDeclarationPath(
  resolutionContext: string,
  specifier: string,
  packageRoot: string,
  accessStyle: AccessStyle,
): string {
  const declarationPath = resolvePackageDeclaration(resolutionContext, specifier, accessStyle);

  if (declarationPath === undefined) {
    throw new UnsupportedInspectionError("The package has no readable declaration entrypoint.");
  }

  const canonicalDeclarationPath = canonicalDeclaration(declarationPath);
  if (!isPathWithin(packageRoot, canonicalDeclarationPath)) {
    throw new UnsupportedInspectionError(
      "The package declaration entrypoint escapes its installed package boundary.",
    );
  }
  return canonicalDeclarationPath;
}

function canonicalDeclaration(declarationPath: string): string {
  const canonicalDeclarationPath = canonicalPath(declarationPath);
  if (canonicalDeclarationPath === undefined) {
    throw new UnsupportedInspectionError("The package has no readable declaration entrypoint.");
  }
  return canonicalDeclarationPath;
}

function resolvePackageDeclaration(
  resolutionContext: string,
  specifier: string,
  accessStyle: AccessStyle,
): string | undefined {
  const contextDirectory = startingDirectory(resolutionContext);
  const containingFile = join(
    contextDirectory,
    accessStyle === "import" ? "__typepeek_resolution__.mts" : "__typepeek_resolution__.cts",
  );
  const compilerOptions = resolutionCompilerOptions();
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    createBoundedModuleResolutionHost(contextDirectory),
    undefined,
    undefined,
    resolutionMode(accessStyle),
  );
  return isDeclarationResolution(resolution.resolvedModule)
    ? resolution.resolvedModule.resolvedFileName
    : undefined;
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

function createBoundedModuleResolutionHost(contextDirectory: string): ts.ModuleResolutionHost {
  return {
    directoryExists: isDirectory,
    fileExists: isFile,
    getCurrentDirectory: () => contextDirectory,
    readFile: readPackageResolutionFile,
    realpath: (fileName) => canonicalPath(fileName) ?? fileName,
  };
}

function readPackageResolutionFile(fileName: string): string | undefined {
  try {
    return readBoundedUtf8File(
      fileName,
      MAX_MANIFEST_BYTES,
      "Inspection exceeded its package manifest size limit.",
    );
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      throw error;
    }
    return undefined;
  }
}

function isDeclarationResolution(
  resolvedModule: ts.ResolvedModuleFull | undefined,
): resolvedModule is ts.ResolvedModuleFull {
  return resolvedModule !== undefined && isDeclarationExtension(resolvedModule.extension);
}

function isDeclarationExtension(extension: string): boolean {
  return (
    extension === ts.Extension.Dts ||
    extension === ts.Extension.Dmts ||
    extension === ts.Extension.Dcts
  );
}

function startingDirectory(resolutionContext: string): string {
  return statSync(resolutionContext).isDirectory() ? resolutionContext : dirname(resolutionContext);
}

function isSafePackagePathSegment(segment: string): boolean {
  return !["", ".", ".."].includes(segment) && !segment.includes("\\") && !segment.includes("\0");
}

function isFile(fileName: string): boolean {
  try {
    return statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function canonicalPath(fileName: string): string | undefined {
  try {
    return realpathSync(fileName);
  } catch {
    return undefined;
  }
}

function readBoundedUtf8File(fileName: string, maxBytes: number, limitMessage: string): string {
  const fileDescriptor = openSync(fileName, "r");
  try {
    return readBoundedUtf8(fileDescriptor, maxBytes, limitMessage);
  } finally {
    closeSync(fileDescriptor);
  }
}

function readBoundedUtf8(fileDescriptor: number, maxBytes: number, limitMessage: string): string {
  // The sentinel byte proves that the file exceeds the budget without ever
  // allocating or reading the complete untrusted file.
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let totalBytesRead = 0;

  while (totalBytesRead < buffer.length) {
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }

  if (totalBytesRead > maxBytes) {
    throw new InspectionLimitError(limitMessage);
  }
  return buffer.toString("utf8", 0, totalBytesRead);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathWithin(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate);
  const escapesToParent = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  return relativePath === "" || (!escapesToParent && !isAbsolute(relativePath));
}
