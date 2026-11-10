import type { Schema } from "effect";
import { Predicate } from "effect";
import { satisfies } from "semver";

import { COMPILER_TYPESCRIPT_VERSION } from "#typepeek/inspection/compiler/compiler-distribution";
import type {
  CompilerWorkSession,
  PackageDeclarationResolver,
} from "#typepeek/inspection/compiler/compiler-work-session";
import { isPathWithin } from "#typepeek/inspection/evidence/evidence-boundary";
import { isSafePackagePathSegment } from "#typepeek/inspection/evidence/installed-package-boundary";
import { PublicSubpathFiles } from "#typepeek/inspection/evidence/public-subpath-files";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type { PublicSubpath } from "#typepeek/inspection/model/protocol";
import { splitCodePoints } from "#typepeek/presentation/code-point-ranges";
import { requireDefined } from "#typepeek/shared/defined-value";

const MAX_EXPORT_TARGET_DEPTH = 32;
const MAX_EXPORT_TARGET_NODES = 1024;
const MAX_PUBLIC_SUBPATHS = 512;

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

interface ExportTargetTraversal {
  readonly blockingTargets: WeakMap<object, boolean>;
  controlNodes: number;
  nodes: number;
}

type ResolutionConditions = ReadonlySet<string>;

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

export const assertPublicSubpath = function assertPublicSubpath(
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

const versionRangeMatchesCompiler = (rangeText: string): boolean =>
  satisfies(COMPILER_TYPESCRIPT_VERSION, rangeText, {
    includePrerelease: true,
  });

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

export interface PublicSubpathDiscoveryOptions {
  readonly packageRootSpecifier: string;
  readonly exports: Schema.Json | undefined;
  readonly packageRoot: string;
  readonly declarationRoots: readonly string[];
  readonly resolver: PackageDeclarationResolver;
  readonly observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"];
}

/** Discovers only exact, resolvable Public Subpaths under one set of resolution conditions. */
export const readPublicSubpaths = function readPublicSubpaths({
  packageRootSpecifier,
  exports,
  packageRoot,
  declarationRoots,
  resolver,
  observeEvidenceDirectory,
}: PublicSubpathDiscoveryOptions): readonly PublicSubpath[] {
  const subpathEntries = publicSubpathEntries(exports);
  assertPublicSubpathCount(subpathEntries.length);

  const targetTraversal: ExportTargetTraversal = {
    blockingTargets: new WeakMap(),
    controlNodes: 0,
    nodes: 0,
  };

  const files = new PublicSubpathFiles(packageRoot, observeEvidenceDirectory);
  const candidateSpecifiers = new Set<string>();

  for (const [subpathKey, target] of subpathEntries) {
    const specifiers = subpathKey.includes("*")
      ? exportTargetPatterns(
          target,
          resolver.conditions,
          targetTraversal
        ).flatMap((targetPattern) =>
          files
            .captures(targetPattern)
            .flatMap((capture) =>
              concretePublicSubpathSpecifier(
                packageRootSpecifier,
                subpathKey,
                capture
              )
            )
        )
      : [`${packageRootSpecifier}${subpathKey.slice(1)}`];

    for (const specifier of specifiers) {
      candidateSpecifiers.add(specifier);
      assertPublicSubpathCount(candidateSpecifiers.size);
    }
  }

  return [...candidateSpecifiers]
    .toSorted()
    .flatMap((specifier) =>
      isResolvablePublicSubpath(specifier, declarationRoots, resolver)
        ? [{ specifier }]
        : []
    );
};
