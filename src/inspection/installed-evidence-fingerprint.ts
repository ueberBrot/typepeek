import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { opendirSync, type Dirent } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
} from "#typepeek/inspection/evidence-boundary";
import {
  EVIDENCE_PROOF_LIMITS,
  MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
  MAX_EXPANDED_EVIDENCE_PROOF_BYTES,
  compactEvidenceProof,
} from "#typepeek/inspection/installed-evidence-format";
import { snapshotBoundedDataPropertyGraph } from "#typepeek/inspection/untrusted-data";

export const MAX_FINGERPRINTED_DIRECTORY_ENTRIES = EVIDENCE_PROOF_LIMITS.directoryEntries;
export { MAX_INSTALLED_EVIDENCE_PROOF_BYTES } from "#typepeek/inspection/installed-evidence-format";

const SHA256_PATTERN = /^[\da-f]{64}$/u;
const boundedEvidenceStringSchema = Schema.String.check(
  Schema.makeFilter((value) => Buffer.byteLength(value) <= EVIDENCE_PROOF_LIMITS.stringBytes, {
    expected: `a string no larger than ${EVIDENCE_PROOF_LIMITS.stringBytes} UTF-8 bytes`,
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
  sourceFormat: Schema.optionalKey(
    Schema.Struct({
      accessStyle: Schema.Literals(["import", "require"]),
      path: boundedEvidencePathSchema,
    }),
  ),
}).check(
  Schema.makeFilter(
    (fingerprint) => fingerprint.sourceFormat === undefined || fingerprint.kind === "declaration",
  ),
);
const installedEvidenceFilePresenceSchema = Schema.Struct({
  path: boundedEvidencePathSchema,
  exists: Schema.Boolean,
  canonicalPath: Schema.optionalKey(boundedEvidencePathSchema),
}).check(Schema.makeFilter((check) => check.exists === (check.canonicalPath !== undefined)));
const installedEvidenceDirectoryFingerprintSchema = Schema.Struct({
  entries: Schema.Natural,
  path: boundedEvidencePathSchema,
  sha256: evidenceSha256Schema,
});
const installedEvidenceDirectoriesSchema = Schema.Array(
  installedEvidenceDirectoryFingerprintSchema,
).check(
  Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.directories),
  Schema.makeFilter(hasBoundedDirectoryEntryTotal, {
    expected: `at most ${MAX_FINGERPRINTED_DIRECTORY_ENTRIES} aggregate directory entries`,
  }),
);
const installedEvidenceResolutionProbeSchema = Schema.Struct({
  accessStyle: Schema.optionalKey(Schema.Literals(["import", "require"])),
  allowedRoots: Schema.optionalKey(
    Schema.Array(boundedEvidencePathSchema).check(
      Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.rootsPerProbe),
    ),
  ),
  canonicalContainingFile: Schema.optionalKey(boundedEvidencePathSchema),
  containingFile: boundedEvidencePathSchema,
  kind: Schema.Literals(["module", "type-reference"]),
  resolvedPath: Schema.optionalKey(boundedEvidencePathSchema),
  specifier: boundedEvidenceStringSchema,
});
export const installedEvidenceProofSchema = Schema.Struct({
  fileChecks: Schema.optionalKey(
    Schema.Array(installedEvidenceFilePresenceSchema).check(
      Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.fileChecks),
    ),
  ),
  directories: installedEvidenceDirectoriesSchema,
  files: Schema.Array(installedEvidenceFingerprintSchema).check(
    Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.files),
  ),
  resolutions: Schema.Array(installedEvidenceResolutionProbeSchema).check(
    Schema.isMaxLength(EVIDENCE_PROOF_LIMITS.probes),
  ),
}).check(
  Schema.makeFilter(hasBoundedProofSize, {
    expected: `an Installed Evidence proof no larger than ${MAX_INSTALLED_EVIDENCE_PROOF_BYTES} UTF-8 bytes`,
  }),
);

export type InstalledEvidenceFingerprint = typeof installedEvidenceFingerprintSchema.Type;
export type InstalledEvidenceFilePresence = typeof installedEvidenceFilePresenceSchema.Type;
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
  sourceFormat?: InstalledEvidenceFingerprint["sourceFormat"],
) => void;

export type ObserveInstalledEvidenceFilePresence = (fileName: string, exists: boolean) => void;

export type ObserveInstalledEvidenceDirectory = (
  directory: string,
  entries: readonly Dirent[],
) => void;

export interface InstalledEvidenceObserver {
  readonly observeDirectory: ObserveInstalledEvidenceDirectory;
  readonly observeFile: ObserveInstalledEvidenceFile;
  readonly observeFilePresence: ObserveInstalledEvidenceFilePresence;
  readonly observeResolution: (probe: InstalledEvidenceResolutionProbe) => void;
}

export interface InstalledEvidenceFingerprintRecorder extends InstalledEvidenceObserver {
  readonly snapshot: () => InstalledEvidenceProof | undefined;
}

/** Records bounded content fingerprints for exactly the files consumed by one inspection. */
export function createInstalledEvidenceFingerprintRecorder(): InstalledEvidenceFingerprintRecorder {
  const fingerprints = new Map<string, InstalledEvidenceFingerprint>();
  const fileChecks = new Map<string, InstalledEvidenceFilePresence>();
  const directories = new Map<string, InstalledEvidenceDirectoryFingerprint>();
  const resolutions = new Map<string, InstalledEvidenceResolutionProbe>();
  let directoryEntryCount = 0;
  let proofBytes = Buffer.byteLength('{"directories":[],"files":[],"resolutions":[]}');
  let cacheable = true;

  const reserveProofEntry = (serialized: string, entries: number): void => {
    proofBytes += Buffer.byteLength(serialized) + (entries === 0 ? 0 : 1);
    if (proofBytes > MAX_EXPANDED_EVIDENCE_PROOF_BYTES) {
      cacheable = false;
    }
  };

  return {
    observeFilePresence: (fileName, exists) => {
      if (!cacheable) return;
      if (!isAbsolute(fileName)) {
        cacheable = false;
        return;
      }
      const path = resolve(fileName);
      const canonicalPath = exists ? canonicalEvidencePath(path) : undefined;
      if (exists && canonicalPath === undefined) {
        cacheable = false;
        return;
      }
      const previous = fileChecks.get(path);
      if (
        previous !== undefined &&
        (previous.exists !== exists || previous.canonicalPath !== canonicalPath)
      ) {
        cacheable = false;
        return;
      }
      if (previous !== undefined) return;
      const check = { path, exists, ...(canonicalPath === undefined ? {} : { canonicalPath }) };
      if (fileChecks.size === 0) {
        proofBytes += Buffer.byteLength(',"fileChecks":[]');
      }
      reserveProofEntry(JSON.stringify(check), fileChecks.size);
      fileChecks.set(path, check);
      if (fileChecks.size > EVIDENCE_PROOF_LIMITS.fileChecks) cacheable = false;
    },
    observeFile: (fileName, contents, kind, sourceFormat) => {
      if (!cacheable) {
        return;
      }
      const path = canonicalEvidencePath(fileName);
      if (
        path === undefined ||
        (sourceFormat !== undefined &&
          (kind !== "declaration" || canonicalEvidencePath(sourceFormat.path) !== path))
      ) {
        cacheable = false;
        return;
      }
      const fingerprint = {
        kind,
        path,
        sha256: sha256(contents),
        ...(sourceFormat === undefined
          ? {}
          : {
              sourceFormat: {
                accessStyle: sourceFormat.accessStyle,
                path: resolve(sourceFormat.path),
              },
            }),
      } as const;
      const previous = fingerprints.get(path);
      if (
        previous !== undefined &&
        (previous.kind !== fingerprint.kind ||
          previous.sha256 !== fingerprint.sha256 ||
          JSON.stringify(previous.sourceFormat) !== JSON.stringify(fingerprint.sourceFormat))
      ) {
        cacheable = false;
        return;
      }
      if (previous === undefined) {
        reserveProofEntry(JSON.stringify(fingerprint), fingerprints.size);
        fingerprints.set(path, fingerprint);
      }
      if (fingerprints.size > EVIDENCE_PROOF_LIMITS.files) {
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
      if (previous === undefined) {
        reserveProofEntry(JSON.stringify(fingerprint), directories.size);
        directories.set(fingerprint.path, fingerprint);
      }
      directoryEntryCount += previous === undefined ? fingerprint.entries : 0;
      if (
        directories.size > EVIDENCE_PROOF_LIMITS.directories ||
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
      const key = JSON.stringify(normalized);
      if (!resolutions.has(key)) {
        reserveProofEntry(key, resolutions.size);
        resolutions.set(key, normalized);
      }
      if (resolutions.size > EVIDENCE_PROOF_LIMITS.probes) {
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
        ...(fileChecks.size === 0
          ? {}
          : {
              fileChecks: [...fileChecks.values()].sort((left, right) =>
                left.path.localeCompare(right.path),
              ),
            }),
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
      maximumObjects: EVIDENCE_PROOF_LIMITS.objects,
      maximumSerializedBytes: MAX_EXPANDED_EVIDENCE_PROOF_BYTES,
      maximumStringBytes: EVIDENCE_PROOF_LIMITS.stringBytes,
      maximumValues: EVIDENCE_PROOF_LIMITS.values,
    }) !== undefined &&
    snapshotBoundedDataPropertyGraph(compactEvidenceProof(proof), {
      maximumObjects: EVIDENCE_PROOF_LIMITS.objects,
      maximumSerializedBytes: MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
      maximumStringBytes: EVIDENCE_PROOF_LIMITS.stringBytes,
      maximumValues: EVIDENCE_PROOF_LIMITS.values,
    }) !== undefined
  );
}
