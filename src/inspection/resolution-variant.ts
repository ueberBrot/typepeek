import type { Dirent } from "node:fs";
import { opendirSync } from "node:fs";
import nodePath from "node:path";

import ts from "@typescript/typescript6";
import type { Schema } from "effect";
import { Predicate } from "effect";

import { splitCodePoints } from "#typepeek/code-point-ranges";
import { requireDefined } from "#typepeek/defined-value";
import type {
  CompilerWorkSession,
  PackageDeclarationResolver,
} from "#typepeek/inspection/compiler-work-session";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  canonicalEvidencePath,
  isEvidenceDirectory,
  isEvidenceFile,
  isPathWithin,
} from "#typepeek/inspection/evidence-boundary";
import { isSafePackagePathSegment } from "#typepeek/inspection/installed-package-boundary";
import type {
  NormalizedInspectionTarget,
  PublicSubpath,
} from "#typepeek/inspection/protocol";

const isExportTargetObject = (
  value: Schema.Json | undefined
): value is Schema.JsonObject =>
  value !== null &&
  value !== undefined &&
  !Array.isArray(value) &&
  Predicate.isReadonlyObject(value);

const isExportTargetArray = (
  value: Schema.Json | undefined
): value is readonly Schema.Json[] => Array.isArray(value);

const MAX_EXPORT_TARGET_DEPTH = 32;
const MAX_EXPORT_TARGET_NODES = 1024;
const MAX_PUBLIC_SUBPATHS = 512;
const MAX_PUBLIC_SUBPATH_FILE_DEPTH = 64;
const MAX_PUBLIC_SUBPATH_FILE_ENTRIES = 4096;

export interface ResolutionVariantSelection {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly request: NormalizedInspectionTarget;
  readonly packageRoot: string;
  readonly packageRootSpecifier: string;
  readonly declarationRoots?: readonly string[];
  readonly missingDeclarationMessage?: string;
  readonly subpathKey?: string;
  readonly exports: Schema.Json | undefined;
}

export interface SelectedResolutionVariant {
  readonly declarationPath: string;
  readonly readPublicSubpaths: () => readonly PublicSubpath[];
}

interface ExportTargetTraversal {
  readonly blockingTargets: WeakMap<object, boolean>;
  controlNodes: number;
  nodes: number;
}

interface PackageFileTraversal {
  entries: number;
  readonly filesBySearchRoot: Map<string, readonly string[]>;
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

interface CompilerVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface TypeScriptInternals {
  readonly Version?: new (value: string) => CompilerVersion;
  readonly VersionRange?: {
    readonly tryParse: (range: string) =>
      | {
          readonly test: (version: CompilerVersion) => boolean;
        }
      | undefined;
  };
}

type ResolutionConditions = ReadonlySet<string>;

const typescriptInternals: typeof ts & TypeScriptInternals = ts;

const isSafePublicSubpathKey = function isSafePublicSubpathKey(
  subpathKey: string
): boolean {
  if (!subpathKey.startsWith("./")) {
    return false;
  }

  const segments = subpathKey.slice(2).split("/");

  const wildcardCount = splitCodePoints(subpathKey).filter(
    (character) => character === "*"
  ).length;

  return (
    segments.length > 0 &&
    segments.every(isSafePackagePathSegment) &&
    wildcardCount <= 1
  );
};

const publicSubpathEntries = function publicSubpathEntries(
  exports: Schema.Json | undefined
): readonly (readonly [subpathKey: string, target: Schema.Json])[] {
  return isExportTargetObject(exports)
    ? Object.entries(exports)
        .filter(
          ([subpathKey, target]) =>
            target !== null && isSafePublicSubpathKey(subpathKey)
        )
        .toSorted(([left], [right]) => {
          if (left < right) {
            return -1;
          }

          if (left > right) {
            return 1;
          }

          return 0;
        })
    : [];
};

const publicSubpathKeys = function publicSubpathKeys(
  exports: Schema.Json | undefined
): readonly string[] {
  return publicSubpathEntries(exports).map(([subpathKey]) => subpathKey);
};

const publicSubpathKeyMatches = function publicSubpathKeyMatches(
  pattern: string,
  subpathKey: string
): boolean {
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
};

const assertPublicSubpath = function assertPublicSubpath(
  subpathKey: string | undefined,
  exports: Schema.Json | undefined
): void {
  if (
    subpathKey !== undefined &&
    !publicSubpathKeys(exports).some((candidate) =>
      publicSubpathKeyMatches(candidate, subpathKey)
    )
  ) {
    throw new UnsupportedInspectionError(
      "The requested Specifier is not a manifest-declared Public Subpath."
    );
  }
};

const canonicalDeclaration = function canonicalDeclaration(
  declarationPath: string,
  resolver: PackageDeclarationResolver
): string {
  const canonicalDeclarationPath = resolver.canonicalPath(declarationPath);

  if (canonicalDeclarationPath === undefined) {
    throw new UnsupportedInspectionError(
      "The package has no readable declaration entrypoint."
    );
  }

  return canonicalDeclarationPath;
};

const resolveDeclarationPath = function resolveDeclarationPath(
  specifier: string,
  declarationRoots: readonly string[],
  missingDeclarationMessage: string | undefined,
  resolver: PackageDeclarationResolver
): string {
  const declarationPath = resolver.resolve(specifier);

  if (declarationPath === undefined) {
    throw new UnsupportedInspectionError(
      missingDeclarationMessage ??
        "The package has no readable declaration entrypoint."
    );
  }

  const canonicalDeclarationPath = canonicalDeclaration(
    declarationPath,
    resolver
  );

  if (
    !declarationRoots.some((root) =>
      isPathWithin(root, canonicalDeclarationPath)
    )
  ) {
    throw new UnsupportedInspectionError(
      "The package declaration entrypoint escapes its installed package boundary."
    );
  }

  return canonicalDeclarationPath;
};

const assertPublicSubpathCount = function assertPublicSubpathCount(
  count: number
): void {
  if (count > MAX_PUBLIC_SUBPATHS) {
    throw new InspectionLimitError(
      "public-subpaths",
      "Inspection exceeded its Public Subpath limit."
    );
  }
};

const reserveExportTargetNode = function reserveExportTargetNode(
  depth: number,
  traversal: ExportTargetTraversal
): void {
  traversal.nodes += 1;

  if (
    traversal.nodes > MAX_EXPORT_TARGET_NODES ||
    depth > MAX_EXPORT_TARGET_DEPTH
  ) {
    throw new InspectionLimitError(
      "package-export-targets",
      "Inspection exceeded its package export target traversal limit."
    );
  }
};

const isSafePackageTargetPattern = function isSafePackageTargetPattern(
  target: string
): boolean {
  if (!target.startsWith("./")) {
    return false;
  }

  const segments = target.slice(2).split("/");

  const wildcardCount = splitCodePoints(target).filter(
    (character) => character === "*"
  ).length;

  return (
    wildcardCount === 1 &&
    segments.length > 0 &&
    segments.every(isSafePackagePathSegment)
  );
};

const readExportTargetPattern = function readExportTargetPattern(
  target: Schema.Json | undefined
): string | undefined {
  return Predicate.isString(target) && isSafePackageTargetPattern(target)
    ? target
    : undefined;
};

const isExportTargetContainer = function isExportTargetContainer(
  target: Schema.Json | undefined
): target is readonly Schema.Json[] | Schema.JsonObject {
  return isExportTargetArray(target) || isExportTargetObject(target);
};

const reserveExportTargetControlNode = function reserveExportTargetControlNode(
  depth: number,
  traversal: ExportTargetTraversal
): void {
  traversal.controlNodes += 1;

  if (
    traversal.controlNodes > MAX_EXPORT_TARGET_NODES ||
    depth > MAX_EXPORT_TARGET_DEPTH
  ) {
    throw new InspectionLimitError(
      "package-export-targets",
      "Inspection exceeded its package export target traversal limit."
    );
  }
};

const versionedTypesRange = function versionedTypesRange(
  condition: string
): string | undefined {
  return condition.startsWith("types@")
    ? condition.slice("types@".length)
    : undefined;
};

const unsupportedVersionedTypesCondition =
  function unsupportedVersionedTypesCondition(): never {
    throw new UnsupportedInspectionError(
      "The TypeScript compiler cannot select versioned package export conditions."
    );
  };

const versionRangeMatchesCompiler = function versionRangeMatchesCompiler(
  rangeText: string
): boolean {
  const { Version, VersionRange } = typescriptInternals;

  if (Version === undefined) {
    return unsupportedVersionedTypesCondition();
  }

  if (VersionRange === undefined) {
    return unsupportedVersionedTypesCondition();
  }

  const range = VersionRange.tryParse(rangeText);

  return range?.test(new Version(ts.version)) ?? false;
};

const isApplicableVersionedTypesCondition =
  function isApplicableVersionedTypesCondition(
    condition: string,
    conditions: ResolutionConditions
  ): boolean {
    if (!conditions.has("types")) {
      return false;
    }

    const rangeText = versionedTypesRange(condition);

    if (rangeText === undefined) {
      return false;
    }

    return versionRangeMatchesCompiler(rangeText);
  };

const isApplicableExportCondition = function isApplicableExportCondition(
  condition: string,
  conditions: ResolutionConditions
): boolean {
  return (
    condition === "default" ||
    conditions.has(condition) ||
    isApplicableVersionedTypesCondition(condition, conditions)
  );
};

const exportTargetAnalysis = {
  calculateBlockingTarget(
    target: readonly Schema.Json[] | Schema.JsonObject,
    conditions: ResolutionConditions,
    traversal: ExportTargetTraversal,
    depth: number
  ): boolean {
    reserveExportTargetControlNode(depth, traversal);

    const children = isExportTargetArray(target)
      ? target
      : Object.entries(target).flatMap(([condition, child]) =>
          isApplicableExportCondition(condition, conditions) ? [child] : []
        );

    const blocks = children.some((child) =>
      exportTargetAnalysis.definitelyBlocksFallback(
        child,
        conditions,
        traversal,
        depth + 1
      )
    );

    traversal.blockingTargets.set(target, blocks);

    return blocks;
  },
  definitelyBlocksFallback(
    target: Schema.Json | undefined,
    conditions: ResolutionConditions,
    traversal: ExportTargetTraversal,
    depth = 0
  ): boolean {
    if (target === null) {
      return true;
    }

    if (!isExportTargetContainer(target)) {
      return false;
    }

    const cached = traversal.blockingTargets.get(target);

    if (cached !== undefined) {
      return cached;
    }

    return exportTargetAnalysis.calculateBlockingTarget(
      target,
      conditions,
      traversal,
      depth
    );
  },
};

const reachableFallbackTargets = function reachableFallbackTargets(
  targets: readonly Schema.Json[],
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal
): readonly Schema.Json[] {
  const reachable: Schema.Json[] = [];

  for (const target of targets) {
    reachable.push(target);

    if (
      exportTargetAnalysis.definitelyBlocksFallback(
        target,
        conditions,
        traversal
      )
    ) {
      break;
    }
  }

  return reachable;
};

const exportTargetChildren = function exportTargetChildren(
  target: Schema.Json | undefined,
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal
): readonly Schema.Json[] {
  if (isExportTargetArray(target)) {
    return reachableFallbackTargets(target, conditions, traversal);
  }

  if (!isExportTargetObject(target)) {
    return [];
  }

  const applicableTargets = Object.entries(target).flatMap(
    ([condition, child]) =>
      isApplicableExportCondition(condition, conditions) ? [child] : []
  );

  return reachableFallbackTargets(applicableTargets, conditions, traversal);
};

const exportTargetPatterns = function exportTargetPatterns(
  target: Schema.Json | undefined,
  conditions: ResolutionConditions,
  traversal: ExportTargetTraversal
): readonly string[] {
  const patterns: string[] = [];

  const pending: {
    readonly target: Schema.Json | undefined;
    readonly depth: number;
  }[] = [{ depth: 0, target }];

  while (pending.length > 0) {
    const candidate = requireDefined(pending.pop());

    reserveExportTargetNode(candidate.depth, traversal);
    const pattern = readExportTargetPattern(candidate.target);

    if (pattern !== undefined) {
      patterns.push(pattern);
      continue;
    }

    const children = exportTargetChildren(
      candidate.target,
      conditions,
      traversal
    );

    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        depth: candidate.depth + 1,
        target: children[index],
      });
    }
  }

  return patterns;
};

const readPackageSearchRoot = function readPackageSearchRoot(
  packageRoot: string,
  searchRoot: string
): PackageSearchRoot | undefined {
  const canonicalSearchRoot = canonicalEvidencePath(searchRoot);

  return canonicalSearchRoot !== undefined &&
    isPathWithin(packageRoot, canonicalSearchRoot) &&
    isEvidenceDirectory(canonicalSearchRoot)
    ? {
        canonicalDirectory: canonicalSearchRoot,
        logicalDirectory: searchRoot,
      }
    : undefined;
};

const readBoundedDirectoryEntries = function readBoundedDirectoryEntries(
  directory: string,
  traversal: {
    entries: number;
  }
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
          "public-subpath-files",
          "Inspection exceeded its Public Subpath file traversal limit."
        );
      }

      entries.push(entry);
    }
  } finally {
    directoryHandle.closeSync();
  }

  return entries.toSorted((left, right) => {
    if (left.name < right.name) {
      return -1;
    }

    if (left.name > right.name) {
      return 1;
    }

    return 0;
  });
};

const observeNearestReadableAncestor = function observeNearestReadableAncestor(
  packageRoot: string,
  searchRoot: string,
  traversal: PackageFileTraversal,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): void {
  if (observeEvidenceDirectory === undefined) {
    return;
  }

  let candidate = nodePath.dirname(searchRoot);

  while (isPathWithin(packageRoot, candidate)) {
    const canonicalCandidate = canonicalEvidencePath(candidate);

    if (
      canonicalCandidate !== undefined &&
      isPathWithin(packageRoot, canonicalCandidate) &&
      isEvidenceDirectory(canonicalCandidate)
    ) {
      observeEvidenceDirectory(
        canonicalCandidate,
        readBoundedDirectoryEntries(canonicalCandidate, traversal)
      );

      return;
    }

    const parent = nodePath.dirname(candidate);

    if (parent === candidate) {
      return;
    }

    candidate = parent;
  }
};

const linkedPackageEntryKind = function linkedPackageEntryKind(
  canonicalEntryPath: string
): PackageEntry["kind"] | undefined {
  if (isEvidenceDirectory(canonicalEntryPath)) {
    return "directory";
  }

  return isEvidenceFile(canonicalEntryPath) ? "file" : undefined;
};

const packageEntryKind = function packageEntryKind(
  entry: Dirent,
  canonicalEntryPath: string
): PackageEntry["kind"] | undefined {
  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isFile()) {
    return "file";
  }

  return entry.isSymbolicLink()
    ? linkedPackageEntryKind(canonicalEntryPath)
    : undefined;
};

const readPackageEntry = function readPackageEntry(
  packageRoot: string,
  logicalDirectory: string,
  entry: Dirent
): readonly PackageEntry[] {
  const logicalPath = nodePath.join(logicalDirectory, entry.name);
  const canonicalEntryPath = canonicalEvidencePath(logicalPath);

  if (canonicalEntryPath === undefined) {
    return [];
  }

  if (!isPathWithin(packageRoot, canonicalEntryPath)) {
    return [];
  }

  const kind = packageEntryKind(entry, canonicalEntryPath);

  return kind === undefined
    ? []
    : [{ canonicalPath: canonicalEntryPath, kind, logicalPath }];
};

const readBoundedPackageFiles = function readBoundedPackageFiles(
  packageRoot: string,
  searchRoot: string,
  traversal: PackageFileTraversal,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): readonly string[] {
  const readableSearchRoot = readPackageSearchRoot(packageRoot, searchRoot);

  if (readableSearchRoot === undefined) {
    observeNearestReadableAncestor(
      packageRoot,
      searchRoot,
      traversal,
      observeEvidenceDirectory
    );

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
    const candidate = requireDefined(pending.pop());

    if (candidate.depth > MAX_PUBLIC_SUBPATH_FILE_DEPTH) {
      throw new InspectionLimitError(
        "public-subpath-files",
        "Inspection exceeded its Public Subpath file traversal depth limit."
      );
    }

    const directoryEntries = readBoundedDirectoryEntries(
      candidate.canonicalDirectory,
      traversal
    );

    observeEvidenceDirectory?.(candidate.canonicalDirectory, directoryEntries);

    const entries = directoryEntries.flatMap((entry) =>
      readPackageEntry(packageRoot, candidate.logicalDirectory, entry)
    );

    pending.push(
      ...entries
        .filter(
          (entry) =>
            entry.kind === "directory" &&
            !candidate.canonicalAncestors.has(entry.canonicalPath)
        )
        .map((entry) => ({
          canonicalAncestors: new Set([
            ...candidate.canonicalAncestors,
            entry.canonicalPath,
          ]),
          canonicalDirectory: entry.canonicalPath,
          depth: candidate.depth + 1,
          logicalDirectory: entry.logicalPath,
        }))
        .toReversed()
    );
    files.push(
      ...entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.logicalPath)
    );
  }

  return files;
};

const packageTargetCapture = function packageTargetCapture(
  packageRoot: string,
  packageFile: string,
  prefix: string,
  suffix: string
): readonly string[] {
  const target = `./${nodePath.relative(packageRoot, packageFile).split(nodePath.sep).join("/")}`;

  return target.startsWith(prefix) &&
    target.endsWith(suffix) &&
    target.length >= prefix.length + suffix.length
    ? [target.slice(prefix.length, target.length - suffix.length)]
    : [];
};

const packageTargetCaptures = function packageTargetCaptures(
  packageRoot: string,
  targetPattern: string,
  traversal: PackageFileTraversal,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): readonly string[] {
  const wildcardIndex = targetPattern.indexOf("*");
  const prefix = targetPattern.slice(0, wildcardIndex);
  const suffix = targetPattern.slice(wildcardIndex + 1);

  const searchRoot = nodePath.join(
    packageRoot,
    nodePath.dirname(prefix.slice(2))
  );

  let files = traversal.filesBySearchRoot.get(searchRoot);

  if (files === undefined) {
    files = readBoundedPackageFiles(
      packageRoot,
      searchRoot,
      traversal,
      observeEvidenceDirectory
    );
    traversal.filesBySearchRoot.set(searchRoot, files);
  }

  return files
    .flatMap((packageFile) =>
      packageTargetCapture(packageRoot, packageFile, prefix, suffix)
    )
    .toSorted();
};

const isSafeConcretePublicSubpathKey = function isSafeConcretePublicSubpathKey(
  subpathKey: string
): boolean {
  return isSafePublicSubpathKey(subpathKey) && !subpathKey.includes("*");
};

const concretePublicSubpathSpecifier = function concretePublicSubpathSpecifier(
  packageRootSpecifier: string,
  subpathKey: string,
  capture: string
): readonly string[] {
  const concreteSubpathKey = subpathKey.replace("*", capture);

  return isSafeConcretePublicSubpathKey(concreteSubpathKey)
    ? [`${packageRootSpecifier}${concreteSubpathKey.slice(1)}`]
    : [];
};

const publicSubpathEntryCandidates = function publicSubpathEntryCandidates(
  packageRootSpecifier: string,
  subpathKey: string,
  target: Schema.Json | undefined,
  packageRoot: string,
  conditions: ResolutionConditions,
  targetTraversal: ExportTargetTraversal,
  fileTraversal: PackageFileTraversal,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): readonly string[] {
  if (!subpathKey.includes("*")) {
    return [`${packageRootSpecifier}${subpathKey.slice(1)}`];
  }

  return exportTargetPatterns(target, conditions, targetTraversal).flatMap(
    (targetPattern) =>
      packageTargetCaptures(
        packageRoot,
        targetPattern,
        fileTraversal,
        observeEvidenceDirectory
      ).flatMap((capture) =>
        concretePublicSubpathSpecifier(
          packageRootSpecifier,
          subpathKey,
          capture
        )
      )
  );
};

const publicSubpathCandidates = function publicSubpathCandidates(
  packageRootSpecifier: string,
  exports: Schema.Json | undefined,
  packageRoot: string,
  conditions: ResolutionConditions,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): readonly string[] {
  const subpathEntries = publicSubpathEntries(exports);
  assertPublicSubpathCount(subpathEntries.length);

  const targetTraversal: ExportTargetTraversal = {
    blockingTargets: new WeakMap(),
    controlNodes: 0,
    nodes: 0,
  };

  const fileTraversal: PackageFileTraversal = {
    entries: 0,
    filesBySearchRoot: new Map(),
  };

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
      observeEvidenceDirectory
    )) {
      candidateSpecifiers.add(specifier);
      assertPublicSubpathCount(candidateSpecifiers.size);
    }
  }

  return [...candidateSpecifiers].toSorted();
};

const isResolvablePublicSubpath = function isResolvablePublicSubpath(
  specifier: string,
  declarationRoots: readonly string[],
  resolver: PackageDeclarationResolver
): boolean {
  const declarationPath = resolver.resolve(specifier);

  const canonicalDeclarationPath =
    declarationPath === undefined
      ? undefined
      : resolver.canonicalPath(declarationPath);

  return (
    canonicalDeclarationPath !== undefined &&
    declarationRoots.some((root) =>
      isPathWithin(root, canonicalDeclarationPath)
    )
  );
};

const publicSubpathSpecifiers = function publicSubpathSpecifiers(
  packageRootSpecifier: string,
  exports: Schema.Json | undefined,
  packageRoot: string,
  declarationRoots: readonly string[],
  resolver: PackageDeclarationResolver,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): readonly PublicSubpath[] {
  return publicSubpathCandidates(
    packageRootSpecifier,
    exports,
    packageRoot,
    resolver.conditions,
    observeEvidenceDirectory
  ).flatMap((specifier) =>
    isResolvablePublicSubpath(specifier, declarationRoots, resolver)
      ? [{ specifier }]
      : []
  );
};

/**
 * Selects one declaration entrypoint and the exact Public Subpaths exposed by
 * the same Resolution Context and Access Style. Manifest and filesystem
 * traversal are bounded and package targets never escape the installed package.
 */
export const selectResolutionVariant = function selectResolutionVariant({
  compilerWorkSession,
  request,
  packageRoot,
  packageRootSpecifier,
  declarationRoots = [packageRoot],
  missingDeclarationMessage,
  subpathKey,
  exports,
}: ResolutionVariantSelection): SelectedResolutionVariant {
  assertPublicSubpath(subpathKey, exports);

  const resolver = compilerWorkSession.createPackageResolver(
    request.resolutionContext,
    request.accessStyle,
    declarationRoots
  );

  return {
    declarationPath: resolveDeclarationPath(
      request.specifier,
      declarationRoots,
      missingDeclarationMessage,
      resolver
    ),
    readPublicSubpaths: () =>
      subpathKey === undefined
        ? publicSubpathSpecifiers(
            packageRootSpecifier,
            exports,
            packageRoot,
            declarationRoots,
            resolver,
            compilerWorkSession.observeEvidenceDirectory
          )
        : [],
  };
};
