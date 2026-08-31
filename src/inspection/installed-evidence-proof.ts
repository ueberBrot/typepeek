import { basename, dirname, join } from "node:path";

import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence-boundary";
import {
  type InstalledEvidenceDirectoryFingerprint,
  type InstalledEvidenceFingerprint,
  type InstalledEvidenceProof,
  type InstalledEvidenceResolutionProbe,
  MAX_FINGERPRINTED_DIRECTORY_ENTRIES,
  readInstalledEvidenceDirectoryFingerprint,
  sha256,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import {
  declarationProviderSegments,
  parsePackageNameSegments,
} from "#typepeek/inspection/installed-package-boundary";
import { readOwnDataProperty } from "#typepeek/inspection/untrusted-data";

const MAX_PROOF_REPLAY_BYTES = 12 * 1_024 * 1_024;

/** Replays one cached Installed Evidence Proof without granting it inspection authority. */
export function installedEvidenceProofStillMatches(
  cached: InstalledEvidenceProof,
  current: InstalledEvidenceProof,
): boolean {
  return (
    currentManifestsMatch(cached, current) &&
    resolutionProbesStillMatch(cached.resolutions, cached.files) &&
    directoryFingerprintsStillMatch(cached.directories) &&
    fileFingerprintsStillMatch(cached.files)
  );
}

function currentManifestsMatch(
  cached: InstalledEvidenceProof,
  current: InstalledEvidenceProof,
): boolean {
  const currentManifests = new Map(
    current.files
      .filter(({ kind }) => kind === "manifest")
      .map((fingerprint) => [fingerprint.path, fingerprint.sha256]),
  );
  const cachedManifests = new Map(
    cached.files
      .filter(({ kind }) => kind === "manifest")
      .map((fingerprint) => [fingerprint.path, fingerprint.sha256]),
  );
  return [...currentManifests].every(
    ([path, fingerprint]) => cachedManifests.get(path) === fingerprint,
  );
}

function directoryFingerprintsStillMatch(
  directories: readonly InstalledEvidenceDirectoryFingerprint[],
): boolean {
  let directoryEntryCount = 0;
  for (const directory of directories) {
    const remainingEntries = MAX_FINGERPRINTED_DIRECTORY_ENTRIES - directoryEntryCount;
    const current = readInstalledEvidenceDirectoryFingerprint(directory.path, remainingEntries);
    if (!directoryFingerprintMatches(current, directory)) {
      return false;
    }
    directoryEntryCount += current.entries;
  }
  return true;
}

function directoryFingerprintMatches(
  current: InstalledEvidenceDirectoryFingerprint | undefined,
  expected: InstalledEvidenceDirectoryFingerprint,
): current is InstalledEvidenceDirectoryFingerprint {
  return (
    current !== undefined &&
    current.path === expected.path &&
    current.entries === expected.entries &&
    current.sha256 === expected.sha256
  );
}

function fileFingerprintsStillMatch(files: readonly InstalledEvidenceFingerprint[]): boolean {
  let byteCount = 0;
  for (const fingerprint of files) {
    const validation = validateFileFingerprint(fingerprint, byteCount);
    if (validation === undefined) {
      return false;
    }
    byteCount = validation;
  }
  return true;
}

function validateFileFingerprint(
  fingerprint: InstalledEvidenceFingerprint,
  consumedBytes: number,
): number | undefined {
  if (canonicalEvidencePath(fingerprint.path) !== fingerprint.path) {
    return undefined;
  }
  try {
    const contents = readBoundedUtf8File(
      fingerprint.path,
      MAX_PROOF_REPLAY_BYTES - consumedBytes,
      "compiler-host-bytes",
      "Inspection cache validation exceeded its byte limit.",
    );
    return sha256(contents) === fingerprint.sha256
      ? consumedBytes + Buffer.byteLength(contents)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolutionProbesStillMatch(
  probes: readonly InstalledEvidenceResolutionProbe[],
  files: readonly InstalledEvidenceFingerprint[],
): boolean {
  try {
    const session = createCompilerWorkSession();
    const manifestRoots = new Set(
      files
        .filter(({ kind, path }) => kind === "manifest" && basename(path) === "package.json")
        .map(({ path }) => dirname(path)),
    );
    return probes.every((probe) => {
      const accessStyle = readOwnOptionalProperty(probe, "accessStyle");
      const canonicalContainingFile =
        readOwnOptionalProperty(probe, "canonicalContainingFile") ?? probe.containingFile;
      const resolvedPath = readOwnOptionalProperty(probe, "resolvedPath");
      const allowedRoots = validatedResolutionRoots(probe.allowedRoots, manifestRoots);
      if (
        allowedRoots === undefined ||
        (allowedRoots.length === 0 && resolvedPath !== undefined) ||
        canonicalEvidenceCandidatePath(probe.containingFile) !== canonicalContainingFile
      ) {
        return false;
      }
      const safeProbe = Object.assign(Object.create(null), probe, {
        accessStyle,
        canonicalContainingFile,
        resolvedPath,
      }) as InstalledEvidenceResolutionProbe;
      return (
        session.resolveEvidenceProbe(safeProbe, [
          ...allowedRoots,
          ...resolutionSearchRoots(safeProbe),
        ]) === resolvedPath
      );
    });
  } catch {
    return false;
  }
}

function resolutionSearchRoots(probe: InstalledEvidenceResolutionProbe): readonly string[] {
  const packageSegments = parsePackageNameSegments(probe.specifier);
  if (packageSegments === undefined) {
    return [];
  }
  const packageName = packageSegments.join("/");
  const providerSegments = declarationProviderSegments(packageName);
  const candidateSegments = [packageSegments, providerSegments].filter(
    (candidate, index, candidates) =>
      candidates.findIndex((other) => other.join("/") === candidate.join("/")) === index,
  );
  const roots: string[] = [];
  let directory = dirname(probe.containingFile);
  for (let depth = 0; depth < 64; depth += 1) {
    for (const segments of candidateSegments) {
      roots.push(join(directory, "node_modules", ...segments));
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return roots;
}

function validatedResolutionRoots(
  roots: readonly string[] | undefined,
  manifestRoots: ReadonlySet<string>,
): readonly string[] | undefined {
  if (roots === undefined) {
    return undefined;
  }
  const validated = new Set<string>();
  for (const root of roots) {
    const canonicalRoot = canonicalEvidencePath(root);
    if (canonicalRoot === undefined || !manifestRoots.has(canonicalRoot)) {
      return undefined;
    }
    validated.add(root);
    validated.add(canonicalRoot);
  }
  return [...validated];
}

function readOwnOptionalProperty<Value extends object, Key extends keyof Value & string>(
  value: Value,
  key: Key,
): Value[Key] | undefined {
  const entry = readOwnDataProperty(value, key);
  return entry?.[1] as Value[Key] | undefined;
}
