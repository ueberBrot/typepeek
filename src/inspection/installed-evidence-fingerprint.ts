import { createHash } from "node:crypto";
import { opendirSync, type Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";

import { canonicalEvidencePath } from "#typepeek/inspection/evidence-boundary";

export const MAX_FINGERPRINTED_FILES = 512;
export const MAX_FINGERPRINTED_DIRECTORIES = 512;
export const MAX_FINGERPRINTED_DIRECTORY_ENTRIES = 4_096;
export const MAX_RESOLUTION_PROBES = 1_024;
const MAX_FINGERPRINT_RECEIPT_BYTES = 64 * 1_024;

export type InstalledEvidenceFileKind = "declaration" | "manifest";

export interface InstalledEvidenceFingerprint {
  readonly kind: InstalledEvidenceFileKind;
  readonly path: string;
  readonly sha256: string;
}

export interface InstalledEvidenceDirectoryFingerprint {
  readonly entries: number;
  readonly path: string;
  readonly sha256: string;
}

export interface InstalledEvidenceResolutionProbe {
  readonly accessStyle?: "import" | "require";
  readonly containingFile: string;
  readonly kind: "module" | "type-reference";
  readonly resolvedPath?: string;
  readonly specifier: string;
}

export interface InstalledEvidenceProof {
  readonly directories: readonly InstalledEvidenceDirectoryFingerprint[];
  readonly files: readonly InstalledEvidenceFingerprint[];
  readonly resolutions: readonly InstalledEvidenceResolutionProbe[];
}

export type ObserveInstalledEvidenceFile = (
  fileName: string,
  contents: string,
  kind: InstalledEvidenceFileKind,
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
      return Buffer.byteLength(JSON.stringify(proof)) <= MAX_FINGERPRINT_RECEIPT_BYTES
        ? proof
        : undefined;
    },
  };
}

function normalizeResolutionProbe(
  probe: InstalledEvidenceResolutionProbe,
): InstalledEvidenceResolutionProbe | undefined {
  const containingFile =
    canonicalEvidencePath(probe.containingFile) ??
    (isAbsolute(probe.containingFile) ? probe.containingFile : undefined);
  if (containingFile === undefined) {
    return undefined;
  }
  if (probe.resolvedPath === undefined) {
    return { ...probe, containingFile };
  }
  const resolvedPath = canonicalEvidencePath(probe.resolvedPath);
  return resolvedPath === undefined ? undefined : { ...probe, containingFile, resolvedPath };
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
