import { Result, Schema } from "effect";
import { createHash } from "node:crypto";
import { opendirSync, type Dirent } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
} from "#typepeek/inspection/evidence-boundary";
import { snapshotBoundedDataPropertyGraph } from "#typepeek/inspection/untrusted-data";

const MAX_FINGERPRINTED_FILES = 512;
const MAX_FINGERPRINTED_DIRECTORIES = 512;
export const MAX_FINGERPRINTED_DIRECTORY_ENTRIES = 4_096;
const MAX_RESOLUTION_PROBES = 1_024;
export const MAX_INSTALLED_EVIDENCE_PROOF_BYTES = 64 * 1_024;
const MAX_EVIDENCE_STRING_BYTES = 4 * 1_024;
const MAX_EVIDENCE_PROOF_OBJECTS = 4_096;
const MAX_EVIDENCE_PROOF_VALUES = 32_768;

const SHA256_PATTERN = /^[\da-f]{64}$/u;
const boundedEvidenceStringSchema = Schema.String.check(
  Schema.makeFilter((value) => Buffer.byteLength(value) <= MAX_EVIDENCE_STRING_BYTES, {
    expected: `a string no larger than ${MAX_EVIDENCE_STRING_BYTES} UTF-8 bytes`,
  }),
);
const boundedEvidencePathSchema = boundedEvidenceStringSchema.check(
  Schema.makeFilter(isAbsolute, { expected: "a bounded absolute path" }),
);
const evidenceSha256Schema = Schema.String.check(
  Schema.makeFilter((value) => SHA256_PATTERN.test(value), {
    expected: "a lowercase SHA-256 digest",
  }),
);
const installedEvidenceFingerprintSchema = Schema.Struct({
  kind: Schema.Literals(["declaration", "manifest"]),
  path: boundedEvidencePathSchema,
  sha256: evidenceSha256Schema,
});
const installedEvidenceDirectoryFingerprintSchema = Schema.Struct({
  entries: Schema.Natural,
  path: boundedEvidencePathSchema,
  sha256: evidenceSha256Schema,
});
const installedEvidenceDirectoriesSchema = Schema.Array(
  installedEvidenceDirectoryFingerprintSchema,
).check(
  Schema.isMaxLength(MAX_FINGERPRINTED_DIRECTORIES),
  Schema.makeFilter(hasBoundedDirectoryEntryTotal, {
    expected: `at most ${MAX_FINGERPRINTED_DIRECTORY_ENTRIES} aggregate directory entries`,
  }),
);
const installedEvidenceResolutionProbeSchema = Schema.Struct({
  accessStyle: Schema.optionalKey(Schema.Literals(["import", "require"])),
  allowedRoots: Schema.optionalKey(
    Schema.Array(boundedEvidencePathSchema).check(Schema.isMaxLength(16)),
  ),
  canonicalContainingFile: Schema.optionalKey(boundedEvidencePathSchema),
  containingFile: boundedEvidencePathSchema,
  kind: Schema.Literals(["module", "type-reference"]),
  resolvedPath: Schema.optionalKey(boundedEvidencePathSchema),
  specifier: boundedEvidenceStringSchema,
});
export const installedEvidenceProofSchema = Schema.Struct({
  directories: installedEvidenceDirectoriesSchema,
  files: Schema.Array(installedEvidenceFingerprintSchema).check(
    Schema.isMaxLength(MAX_FINGERPRINTED_FILES),
  ),
  resolutions: Schema.Array(installedEvidenceResolutionProbeSchema).check(
    Schema.isMaxLength(MAX_RESOLUTION_PROBES),
  ),
}).check(
  Schema.makeFilter(hasBoundedProofSize, {
    expected: `an Installed Evidence proof no larger than ${MAX_INSTALLED_EVIDENCE_PROOF_BYTES} UTF-8 bytes`,
  }),
);

export type InstalledEvidenceFingerprint = typeof installedEvidenceFingerprintSchema.Type;
export type InstalledEvidenceDirectoryFingerprint =
  typeof installedEvidenceDirectoryFingerprintSchema.Type;
export type InstalledEvidenceResolutionProbe = typeof installedEvidenceResolutionProbeSchema.Type;
export type InstalledEvidenceProof = typeof installedEvidenceProofSchema.Type;

const decodeInstalledEvidenceProof = Schema.decodeUnknownResult(installedEvidenceProofSchema, {
  onExcessProperty: "error",
});

function readInstalledEvidenceProof(value: unknown): InstalledEvidenceProof | undefined {
  return Result.getOrUndefined(decodeInstalledEvidenceProof(value));
}

export type ObserveInstalledEvidenceFile = (
  fileName: string,
  contents: string,
  kind: InstalledEvidenceFingerprint["kind"],
) => void;

export type ObserveInstalledEvidenceDirectory = (
  directory: string,
  entries: readonly Dirent[],
) => void;

export interface InstalledEvidenceObserver {
  readonly observeDirectory: ObserveInstalledEvidenceDirectory;
  readonly observeFile: ObserveInstalledEvidenceFile;
  readonly observeResolution: (probe: InstalledEvidenceResolutionProbe) => void;
}

export interface InstalledEvidenceFingerprintRecorder extends InstalledEvidenceObserver {
  readonly snapshot: () => InstalledEvidenceProof | undefined;
}

/** Records bounded content fingerprints for exactly the files consumed by one inspection. */
export function createInstalledEvidenceFingerprintRecorder(): InstalledEvidenceFingerprintRecorder {
  const fingerprints = new Map<string, InstalledEvidenceFingerprint>();
  const directories = new Map<string, InstalledEvidenceDirectoryFingerprint>();
  const resolutions = new Map<string, InstalledEvidenceResolutionProbe>();
  let directoryEntryCount = 0;
  let cacheable = true;

  return {
    observeFile: (fileName, contents, kind) => {
      if (!cacheable) {
        return;
      }
      const path = canonicalEvidencePath(fileName);
      if (path === undefined) {
        cacheable = false;
        return;
      }
      const fingerprint = {
        kind,
        path,
        sha256: sha256(contents),
      } as const;
      const previous = fingerprints.get(path);
      if (
        previous !== undefined &&
        (previous.kind !== fingerprint.kind || previous.sha256 !== fingerprint.sha256)
      ) {
        cacheable = false;
        return;
      }
      fingerprints.set(path, fingerprint);
      if (fingerprints.size > MAX_FINGERPRINTED_FILES) {
        cacheable = false;
      }
    },
    observeDirectory: (directory, entries) => {
      if (!cacheable) {
        return;
      }
      const fingerprint = fingerprintInstalledEvidenceDirectory(directory, entries);
      if (fingerprint === undefined) {
        cacheable = false;
        return;
      }
      const previous = directories.get(fingerprint.path);
      if (
        previous !== undefined &&
        (previous.entries !== fingerprint.entries || previous.sha256 !== fingerprint.sha256)
      ) {
        cacheable = false;
        return;
      }
      directories.set(fingerprint.path, fingerprint);
      directoryEntryCount += previous === undefined ? fingerprint.entries : 0;
      if (
        directories.size > MAX_FINGERPRINTED_DIRECTORIES ||
        directoryEntryCount > MAX_FINGERPRINTED_DIRECTORY_ENTRIES
      ) {
        cacheable = false;
      }
    },
    observeResolution: (probe) => {
      if (!cacheable) {
        return;
      }
      const normalized = normalizeResolutionProbe(probe);
      if (normalized === undefined) {
        cacheable = false;
        return;
      }
      resolutions.set(JSON.stringify(normalized), normalized);
      if (resolutions.size > MAX_RESOLUTION_PROBES) {
        cacheable = false;
      }
    },
    snapshot: () => {
      if (!cacheable) {
        return undefined;
      }
      const files = [...fingerprints.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      const proof = {
        directories: [...directories.values()].sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
        files,
        resolutions: [...resolutions.values()].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      };
      return readInstalledEvidenceProof(proof);
    },
  };
}

function normalizeResolutionProbe(
  probe: InstalledEvidenceResolutionProbe,
): InstalledEvidenceResolutionProbe | undefined {
  const canonicalContainingFile = isAbsolute(probe.containingFile)
    ? canonicalEvidenceCandidatePath(probe.containingFile)
    : undefined;
  if (canonicalContainingFile === undefined) {
    return undefined;
  }
  const containingFile = resolve(probe.containingFile);
  const allowedRoots = normalizedResolutionRoots(probe.allowedRoots);
  if (
    allowedRoots === undefined ||
    (allowedRoots.length === 0 && probe.resolvedPath !== undefined)
  ) {
    return undefined;
  }
  const normalizedProbe = {
    ...probe,
    allowedRoots,
    containingFile,
    ...(canonicalContainingFile === containingFile ? {} : { canonicalContainingFile }),
  };
  if (probe.resolvedPath === undefined) {
    return normalizedProbe;
  }
  const resolvedPath = canonicalEvidencePath(probe.resolvedPath);
  return resolvedPath === undefined ? undefined : { ...normalizedProbe, resolvedPath };
}

function normalizedResolutionRoots(
  roots: readonly string[] | undefined,
): readonly string[] | undefined {
  if (roots === undefined) {
    return undefined;
  }
  const normalized = new Map<string, string>();
  for (const root of roots) {
    if (!isAbsolute(root)) {
      return undefined;
    }
    const logicalRoot = resolve(root);
    const canonicalRoot = canonicalEvidencePath(root);
    if (canonicalRoot === undefined) {
      return undefined;
    }
    const current = normalized.get(canonicalRoot);
    if (current === undefined || (current === canonicalRoot && logicalRoot !== canonicalRoot)) {
      normalized.set(canonicalRoot, logicalRoot);
    }
  }
  return [...normalized.values()];
}

/** Re-reads one directory under an aggregate entry allowance for cache validation. */
export function readInstalledEvidenceDirectoryFingerprint(
  directory: string,
  maximumEntries: number,
): InstalledEvidenceDirectoryFingerprint | undefined {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    return undefined;
  }
  try {
    const entries: Dirent[] = [];
    const handle = opendirSync(directory);
    try {
      while (true) {
        const entry = handle.readSync();
        if (entry === null) {
          break;
        }
        entries.push(entry);
        if (entries.length > maximumEntries) {
          return undefined;
        }
      }
    } finally {
      handle.closeSync();
    }
    return fingerprintInstalledEvidenceDirectory(directory, entries);
  } catch {
    return undefined;
  }
}

function fingerprintInstalledEvidenceDirectory(
  directory: string,
  entries: readonly Dirent[],
): InstalledEvidenceDirectoryFingerprint | undefined {
  const path = canonicalEvidencePath(directory);
  if (path === undefined || entries.length > MAX_FINGERPRINTED_DIRECTORY_ENTRIES) {
    return undefined;
  }
  const contents = entries
    .map((entry) => ({
      canonicalPath: canonicalEvidencePath(join(path, entry.name)) ?? null,
      kind: directoryEntryKind(entry),
      name: entry.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    entries: contents.length,
    path,
    sha256: sha256(JSON.stringify(contents)),
  };
}

function directoryEntryKind(entry: Dirent): string {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symbolic-link";
  if (entry.isBlockDevice()) return "block-device";
  if (entry.isCharacterDevice()) return "character-device";
  if (entry.isFIFO()) return "fifo";
  return entry.isSocket() ? "socket" : "unknown";
}

export function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function hasBoundedDirectoryEntryTotal(
  directories: readonly (typeof installedEvidenceDirectoryFingerprintSchema.Type)[],
): boolean {
  let remaining = MAX_FINGERPRINTED_DIRECTORY_ENTRIES;
  for (const directory of directories) {
    if (directory.entries > remaining) {
      return false;
    }
    remaining -= directory.entries;
  }
  return true;
}

function hasBoundedProofSize(proof: typeof installedEvidenceProofSchema.Type): boolean {
  return (
    snapshotBoundedDataPropertyGraph(proof, {
      maximumObjects: MAX_EVIDENCE_PROOF_OBJECTS,
      maximumSerializedBytes: MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
      maximumStringBytes: MAX_EVIDENCE_STRING_BYTES,
      maximumValues: MAX_EVIDENCE_PROOF_VALUES,
    }) !== undefined
  );
}
