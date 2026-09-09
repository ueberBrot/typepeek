import { basename, dirname, join } from "node:path";

import {
  type CompilerWorkSession,
  createCompilerWorkSession,
} from "#typepeek/inspection/compiler-work-session";
import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
  isEvidenceFile,
  isPathWithin,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence-boundary";
import {
  type InstalledEvidenceDirectoryFingerprint,
  type InstalledEvidenceFingerprint,
  type InstalledEvidenceFilePresence,
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

const MAX_PROOF_REPLAY_BYTES = 24 * 1_024 * 1_024;

/** Replays one cached Installed Evidence Proof without granting it inspection authority. */
export function installedEvidenceProofStillMatches(
  cached: InstalledEvidenceProof,
  current: InstalledEvidenceProof,
): boolean {
  const session = createCompilerWorkSession();
  if (
    !currentManifestsMatch(cached, current) ||
    !fileChecksStillMatch(readOwnOptionalProperty(cached, "fileChecks") ?? [], session) ||
    !fileFingerprintsStillMatch(cached.files) ||
    !directoryFingerprintsStillMatch(cached.directories)
  ) {
    return false;
  }
  const manifestRoots = new Set(
    cached.files
      .filter(({ kind, path }) => kind === "manifest" && basename(path) === "package.json")
      .map(({ path }) => dirname(path)),
  );
  return (
    sourceFormatsStillMatch(cached.files, cached.resolutions, manifestRoots, session) &&
    resolutionProbesStillMatch(cached.resolutions, manifestRoots, session)
  );
}

function fileChecksStillMatch(
  checks: readonly InstalledEvidenceFilePresence[],
  session: CompilerWorkSession,
): boolean {
  try {
    return checks.every((check) => {
      session.reserveOperations(check.exists ? 2 : 1);
      return (
        isEvidenceFile(check.path) === check.exists &&
        (!check.exists ||
          canonicalEvidencePath(check.path) === readOwnOptionalProperty(check, "canonicalPath"))
      );
    });
  } catch {
    return false;
  }
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

/** Rechecks file format independently of explicit import/require resolution overrides. */
function sourceFormatsStillMatch(
  files: readonly InstalledEvidenceFingerprint[],
  probes: readonly InstalledEvidenceResolutionProbe[],
  manifestRoots: ReadonlySet<string>,
  session: CompilerWorkSession,
): boolean {
  try {
    const knownRoots = [
      ...new Set([...manifestRoots, ...probes.flatMap((probe) => probe.allowedRoots ?? [])]),
    ];
    return files.every((fingerprint) => {
      const sourceFormat = readOwnOptionalProperty(fingerprint, "sourceFormat");
      if (sourceFormat === undefined) return true;
      if (canonicalEvidencePath(sourceFormat.path) !== fingerprint.path) return false;
      const roots = validatedResolutionRoots(
        knownRoots.filter((root) => isPathWithin(root, sourceFormat.path)),
        manifestRoots,
      );
      return (
        roots !== undefined &&
        roots.length > 0 &&
        session.readEvidenceFileFormat(sourceFormat.path, roots) === sourceFormat.accessStyle
      );
    });
  } catch {
    return false;
  }
}

function resolutionProbesStillMatch(
  probes: readonly InstalledEvidenceResolutionProbe[],
  manifestRoots: ReadonlySet<string>,
  session: CompilerWorkSession,
): boolean {
  try {
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
