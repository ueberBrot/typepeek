import nodePath from "node:path";

import { Predicate, Schema } from "effect";

import { requireDefined } from "#typepeek/defined-value";
import type { InstalledEvidenceProof } from "#typepeek/inspection/installed-evidence-fingerprint";
import {
  readOwnOptionalProperty,
  snapshotBoundedDataPropertyGraph,
} from "#typepeek/inspection/untrusted-data";

export const EVIDENCE_PROOF_LIMITS = {
  directories: 512,
  directoryEntries: 4096,
  fileChecks: 2048,
  files: 3072,
  objects: 65_536,
  paths: 16_384,
  probes: 16_384,
  rootsPerProbe: 16,
  stringBytes: 4096,
  values: 262_144,
} as const;

export const MAX_INSTALLED_EVIDENCE_PROOF_BYTES = 1024 * 1024;
export const MAX_EXPANDED_EVIDENCE_PROOF_BYTES = 8 * 1024 * 1024;

const indexSchema = Schema.Natural;
const optionalIndexSchema = Schema.NullOr(indexSchema);

const stringSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => Buffer.byteLength(value) <= EVIDENCE_PROOF_LIMITS.stringBytes
  )
);

const readOwnFileChecks = function readOwnFileChecks<
  Proof extends InstalledEvidenceProof | CompactInstalledEvidenceProof,
>(proof: Proof): Proof["fileChecks"] | undefined {
  return readOwnOptionalProperty(proof, "fileChecks");
};

const hasValidReferences = function hasValidReferences(
  proof: CompactInstalledEvidenceProof
): boolean {
  const valid = (index: number) => index < proof.paths.length;
  const optional = (index: number | null) => index === null || valid(index);

  if (!proof.rootSets.every((roots) => roots.every(valid))) {
    return false;
  }

  if (
    !(readOwnFileChecks(proof) ?? []).every(
      ([index, , canonical]) => valid(index) && optional(canonical)
    )
  ) {
    return false;
  }

  if (
    !proof.files.every(
      ([, index, , sourceFormat]) =>
        valid(index) &&
        (sourceFormat === null ||
          Predicate.isString(sourceFormat) ||
          valid(sourceFormat[1]))
    )
  ) {
    return false;
  }

  if (!proof.directories.every(([index]) => valid(index))) {
    return false;
  }

  return proof.resolutions.every(
    ([_access, _context, index, canonical, _specifier, resolved, roots]) => {
      if (!valid(index)) {
        return false;
      }

      if (!optional(canonical)) {
        return false;
      }

      if (!optional(resolved)) {
        return false;
      }

      return roots === null || roots < proof.rootSets.length;
    }
  );
};

const expandPath = function expandPath(prefix: string, suffix: string): string {
  return nodePath.isAbsolute(suffix) ? suffix : prefix + suffix;
};

const hasBoundedExpansion = function hasBoundedExpansion(
  proof: CompactInstalledEvidenceProof
): boolean {
  if (
    snapshotBoundedDataPropertyGraph(proof, {
      maximumObjects: EVIDENCE_PROOF_LIMITS.objects,
      maximumSerializedBytes: MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
      maximumStringBytes: EVIDENCE_PROOF_LIMITS.stringBytes,
      maximumValues: EVIDENCE_PROOF_LIMITS.values,
    }) === undefined
  ) {
    return false;
  }

  const paths = proof.paths.map((suffix) => expandPath(proof.prefix, suffix));

  if (
    paths.some(
      (path) =>
        !nodePath.isAbsolute(path) ||
        Buffer.byteLength(path) > EVIDENCE_PROOF_LIMITS.stringBytes
    )
  ) {
    return false;
  }

  const sizes = paths.map((path) => Buffer.byteLength(path));

  const size = (index: number | null) =>
    index === null ? 0 : requireDefined(sizes[index]);

  const rootSizes = proof.rootSets.map((roots) =>
    roots.reduce((sum, index) => sum + size(index), 0)
  );

  let bytes = 0;

  for (const [index, , canonical] of readOwnFileChecks(proof) ?? []) {
    bytes += size(index) + size(canonical);
  }

  for (const [, index, hash, sourceFormat] of proof.files) {
    bytes += size(index) + hash.length;

    if (sourceFormat !== null) {
      bytes += size(Predicate.isString(sourceFormat) ? index : sourceFormat[1]);
    }
  }

  for (const [index, , hash] of proof.directories) {
    bytes += size(index) + hash.length;
  }

  for (const resolution of proof.resolutions) {
    const {
      2: index,
      3: canonical,
      4: specifier,
      5: resolved,
      6: roots,
    } = resolution;

    bytes +=
      size(index) +
      size(canonical) +
      size(resolved) +
      Buffer.byteLength(specifier) +
      (roots === null ? 0 : requireDefined(rootSizes[roots]));
  }

  // Reject amplification before allocating the expanded arrays; the logical schema
  // then enforces the exact serialized-byte limit, including keys and escaping.
  return bytes <= MAX_EXPANDED_EVIDENCE_PROOF_BYTES;
};

/** A lossless path dictionary; indexes are validated before expanding any evidence. */
export const compactEvidenceProofSchema = Schema.Struct({
  directories: Schema.Array(
    Schema.Tuple([indexSchema, Schema.Natural, stringSchema])
  ).check(Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.directories)),
  fileChecks: Schema.optionalKey(
    Schema.Array(
      Schema.Tuple([indexSchema, Schema.Boolean, optionalIndexSchema])
    ).check(Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.fileChecks))
  ),
  files: Schema.Array(
    Schema.Tuple([
      Schema.Literals(["declaration", "manifest"]),
      indexSchema,
      stringSchema,
      Schema.NullOr(
        Schema.Union([
          Schema.Literals(["import", "require"]),
          Schema.Tuple([Schema.Literals(["import", "require"]), indexSchema]),
        ])
      ),
    ])
  ).check(Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.files)),
  paths: Schema.Array(stringSchema).check(
    Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.paths)
  ),
  prefix: stringSchema,
  resolutions: Schema.Array(
    Schema.Tuple([
      Schema.Literals(["module", "type-reference"]),
      Schema.NullOr(Schema.Literals(["import", "require"])),
      indexSchema,
      optionalIndexSchema,
      stringSchema,
      optionalIndexSchema,
      optionalIndexSchema,
    ])
  ).check(Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.probes)),
  rootSets: Schema.Array(
    Schema.Array(indexSchema).check(
      Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.rootsPerProbe)
    )
  ).check(Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.probes)),
}).check(
  Schema.makeFilter(hasValidReferences, {
    expected: "valid evidence dictionary references",
  }),
  Schema.makeFilter(hasBoundedExpansion, {
    expected: "bounded encoded and expanded evidence",
  })
);

export type CompactInstalledEvidenceProof =
  typeof compactEvidenceProofSchema.Type;

/** Ancestor metadata outside the package must not expand every package path. */
const mostUsefulPathPrefix = function mostUsefulPathPrefix(
  paths: readonly string[]
): string {
  const counts = new Map<string, number>();
  let selected = "";
  let savedBytes = 0;

  for (const path of paths) {
    for (let index = 0; index < path.length; index += 1) {
      if (path[index] !== "/" && path[index] !== "\\") {
        continue;
      }

      const prefix = path.slice(0, index + 1);
      const previous = counts.get(prefix);

      if (
        previous === undefined &&
        counts.size === EVIDENCE_PROOF_LIMITS.paths
      ) {
        return selected;
      }

      const count = (previous ?? 0) + 1;
      counts.set(prefix, count);
      const savings = Buffer.byteLength(prefix) * (count - 1);

      if (
        savings > savedBytes ||
        (savings === savedBytes && prefix < selected)
      ) {
        savedBytes = savings;
        selected = prefix;
      }
    }
  }

  return selected;
};

export const compactEvidenceProof = function compactEvidenceProof(
  proof: InstalledEvidenceProof
): CompactInstalledEvidenceProof {
  const paths: string[] = [];
  const indexes = new Map<string, number>();

  const pathIndex = (path: string): number => {
    let index = indexes.get(path);

    if (index === undefined) {
      index = paths.length;
      indexes.set(path, index);
      paths.push(path);
    }

    return index;
  };

  const rootSets: number[][] = [];
  const rootIndexes = new Map<string, number>();

  const rootsIndex = (roots: readonly string[] | undefined): number | null => {
    if (roots === undefined) {
      return null;
    }

    const mapped = roots.map(pathIndex);
    const key = mapped.join(",");
    let index = rootIndexes.get(key);

    if (index === undefined) {
      index = rootSets.length;
      rootIndexes.set(key, index);
      rootSets.push(mapped);
    }

    return index;
  };

  const optionalPathIndex = (path: string | undefined) =>
    path === undefined ? null : pathIndex(path);

  const files = proof.files.map(({ kind, path, sha256, sourceFormat }) => {
    let compactFormat: CompactInstalledEvidenceProof["files"][number][3];

    if (sourceFormat === undefined) {
      compactFormat = null;
    } else if (sourceFormat.path === path) {
      compactFormat = sourceFormat.accessStyle;
    } else {
      compactFormat = [sourceFormat.accessStyle, pathIndex(sourceFormat.path)];
    }

    return [kind, pathIndex(path), sha256, compactFormat] as const;
  });

  const fileChecks = readOwnFileChecks(proof)?.map(
    ({ path, exists, canonicalPath }) =>
      [pathIndex(path), exists, optionalPathIndex(canonicalPath)] as const
  );

  const directories = proof.directories.map(
    ({ path, entries, sha256 }) => [pathIndex(path), entries, sha256] as const
  );

  const resolutions = proof.resolutions.map(
    (probe) =>
      [
        probe.kind,
        probe.accessStyle ?? null,
        pathIndex(probe.containingFile),
        optionalPathIndex(probe.canonicalContainingFile),
        probe.specifier,
        optionalPathIndex(probe.resolvedPath),
        rootsIndex(probe.allowedRoots),
      ] as const
  );

  const prefix = mostUsefulPathPrefix(paths);

  return {
    paths: paths.map((path) => {
      const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : path;

      return nodePath.isAbsolute(suffix) ? path : suffix;
    }),
    prefix,
    rootSets,
    ...(fileChecks !== undefined && { fileChecks }),
    directories,
    files,
    resolutions,
  };
};

export const expandEvidenceProof = function expandEvidenceProof(
  proof: CompactInstalledEvidenceProof
): InstalledEvidenceProof {
  const path = (index: number): string =>
    expandPath(proof.prefix, requireDefined(proof.paths[index]));

  const fileChecks = readOwnFileChecks(proof);

  return {
    ...(fileChecks !== undefined && {
      fileChecks: fileChecks.map(([index, exists, canonical]) => ({
        exists,
        path: path(index),
        ...(canonical !== null && { canonicalPath: path(canonical) }),
      })),
    }),
    directories: proof.directories.map(([index, entries, sha256]) => ({
      entries,
      path: path(index),
      sha256,
    })),
    files: proof.files.map(([kind, index, sha256, sourceFormat]) => ({
      kind,
      path: path(index),
      sha256,
      ...(sourceFormat !== null && {
        sourceFormat: Predicate.isString(sourceFormat)
          ? { accessStyle: sourceFormat, path: path(index) }
          : { accessStyle: sourceFormat[0], path: path(sourceFormat[1]) },
      }),
    })),
    resolutions: proof.resolutions.map(
      ([kind, accessStyle, index, canonical, specifier, resolved, roots]) => ({
        kind,
        ...(accessStyle !== null && { accessStyle }),
        containingFile: path(index),
        ...(canonical !== null && { canonicalContainingFile: path(canonical) }),
        specifier,
        ...(resolved !== null && { resolvedPath: path(resolved) }),
        ...(roots !== null && {
          allowedRoots: requireDefined(proof.rootSets[roots]).map(path),
        }),
      })
    ),
  };
};
