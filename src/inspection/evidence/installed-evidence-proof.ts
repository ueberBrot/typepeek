import { cachedCompilerLookup } from "#typepeek/inspection/compiler/compiler-cache";
import { createCompilerSessionOwner } from "#typepeek/inspection/compiler/compiler-session-owner";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import {
  canonicalEvidenceCandidatePath,
  canonicalEvidencePath,
  isEvidenceFile,
  isPathWithin,
  readBoundedUtf8File,
} from "#typepeek/inspection/evidence/evidence-boundary";
import type {
  InstalledEvidenceDirectoryFingerprint,
  InstalledEvidenceFilePresence,
  InstalledEvidenceFingerprint,
  InstalledEvidenceProof,
  InstalledEvidenceResolutionProbe,
} from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import {
  MAX_FINGERPRINTED_DIRECTORY_ENTRIES,
  readInstalledEvidenceDirectoryFingerprint,
  sha256,
} from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import {
  declarationProviderSegments,
  findVisiblePackageForDependency,
  parsePackageNameSegments,
} from "#typepeek/inspection/evidence/installed-package-boundary";
import { readOwnOptionalProperty } from "#typepeek/inspection/model/untrusted-data";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { everyAsync } from "#typepeek/shared/async-collection";

const MAX_PROOF_REPLAY_BYTES = 24 * 1024 * 1024;

const currentManifestsMatch = function currentManifestsMatch(
  cached: InstalledEvidenceProof,
  current: InstalledEvidenceProof
): boolean {
  const currentManifests = new Map(
    current.files
      .filter(({ kind }) => kind === "manifest")
      .map((fingerprint) => [fingerprint.path, fingerprint.sha256])
  );

  const cachedManifests = new Map(
    cached.files
      .filter(({ kind }) => kind === "manifest")
      .map((fingerprint) => [fingerprint.path, fingerprint.sha256])
  );

  return [...currentManifests].every(
    ([path, fingerprint]) => cachedManifests.get(path) === fingerprint
  );
};

const fileChecksStillMatch = function fileChecksStillMatch(
  checks: readonly InstalledEvidenceFilePresence[],
  session: CompilerWorkSession
): boolean {
  try {
    return checks.every((check) => {
      session.reserveOperations(check.exists ? 2 : 1);

      return (
        isEvidenceFile(check.path) === check.exists &&
        (!check.exists ||
          canonicalEvidencePath(check.path) ===
            readOwnOptionalProperty(check, "canonicalPath"))
      );
    });
  } catch {
    return false;
  }
};

const validateFileFingerprint = function validateFileFingerprint(
  fingerprint: InstalledEvidenceFingerprint,
  consumedBytes: number
): number | undefined {
  if (canonicalEvidencePath(fingerprint.path) !== fingerprint.path) {
    return undefined;
  }

  try {
    const contents = readBoundedUtf8File(
      fingerprint.path,
      MAX_PROOF_REPLAY_BYTES - consumedBytes,
      "compiler-host-bytes",
      "Inspection cache validation exceeded its byte limit."
    );

    return sha256(contents) === fingerprint.sha256
      ? consumedBytes + Buffer.byteLength(contents)
      : undefined;
  } catch {
    return undefined;
  }
};

const fileFingerprintsStillMatch = function fileFingerprintsStillMatch(
  files: readonly InstalledEvidenceFingerprint[]
): boolean {
  let byteCount = 0;

  for (const fingerprint of files) {
    const validation = validateFileFingerprint(fingerprint, byteCount);

    if (validation === undefined) {
      return false;
    }

    byteCount = validation;
  }

  return true;
};

const directoryFingerprintMatches = function directoryFingerprintMatches(
  current: InstalledEvidenceDirectoryFingerprint | undefined,
  expected: InstalledEvidenceDirectoryFingerprint
): current is InstalledEvidenceDirectoryFingerprint {
  return (
    current !== undefined &&
    current.path === expected.path &&
    current.entries === expected.entries &&
    current.sha256 === expected.sha256
  );
};

const directoryFingerprintsStillMatch =
  function directoryFingerprintsStillMatch(
    directories: readonly InstalledEvidenceDirectoryFingerprint[]
  ): boolean {
    let directoryEntryCount = 0;

    for (const directory of directories) {
      const remainingEntries =
        MAX_FINGERPRINTED_DIRECTORY_ENTRIES - directoryEntryCount;

      const current = readInstalledEvidenceDirectoryFingerprint(
        directory.path,
        remainingEntries
      );

      if (!directoryFingerprintMatches(current, directory)) {
        return false;
      }

      directoryEntryCount += current.entries;
    }

    return true;
  };

const validatedResolutionRoots = function validatedResolutionRoots(
  roots: readonly string[] | undefined,
  manifestRoots: ReadonlySet<string>
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
};

/** Rechecks file format independently of explicit import/require resolution overrides. */
const sourceFormatsStillMatch = function sourceFormatsStillMatch(
  files: readonly InstalledEvidenceFingerprint[],
  probes: readonly InstalledEvidenceResolutionProbe[],
  manifestRoots: ReadonlySet<string>,
  session: CompilerWorkSession
): boolean {
  try {
    const knownRoots = [
      ...new Set([
        ...manifestRoots,
        ...probes.flatMap((probe) => probe.allowedRoots ?? []),
      ]),
    ];

    return files.every((fingerprint) => {
      const sourceFormat = readOwnOptionalProperty(fingerprint, "sourceFormat");

      if (sourceFormat === undefined) {
        return true;
      }

      if (canonicalEvidencePath(sourceFormat.path) !== fingerprint.path) {
        return false;
      }

      const roots = validatedResolutionRoots(
        knownRoots.filter((root) => isPathWithin(root, sourceFormat.path)),
        manifestRoots
      );

      return (
        roots !== undefined &&
        roots.length > 0 &&
        session.readEvidenceFileFormat(sourceFormat.path, roots) ===
          sourceFormat.accessStyle
      );
    });
  } catch {
    return false;
  }
};

const resolutionSearchRoots = function resolutionSearchRoots(
  probe: InstalledEvidenceResolutionProbe,
  session: CompilerWorkSession
): readonly string[] {
  const packageSegments = parsePackageNameSegments(probe.specifier);

  if (packageSegments === undefined) {
    return [];
  }

  const packageName = packageSegments.join("/");
  const providerSegments = declarationProviderSegments(packageName);

  const candidates = [
    { declared: packageName, physical: packageSegments },
    { declared: providerSegments.join("/"), physical: providerSegments },
    ...(probe.kind === "module"
      ? [{ declared: packageName, physical: providerSegments }]
      : []),
  ];

  // Replay must retain the containing package's dependency authority. Hoisted
  // packages that a cold inspection cannot use cannot invalidate its result.
  return candidates.flatMap(({ declared, physical }) => {
    const location = findVisiblePackageForDependency(
      nodePath.dirname(probe.containingFile),
      declared,
      physical,
      session.packageBoundaryObserver
    );

    return location === undefined ? [] : [location.packageRoot];
  });
};

const resolutionProbesStillMatch = async function resolutionProbesStillMatch(
  probes: readonly InstalledEvidenceResolutionProbe[],
  manifestRoots: ReadonlySet<string>,
  session: CompilerWorkSession
): Promise<boolean> {
  const searchRootsByPackage = new Map<string, readonly string[]>();

  try {
    return await everyAsync(probes, async (probe) => {
      const accessStyle = readOwnOptionalProperty(probe, "accessStyle");

      const canonicalContainingFile =
        readOwnOptionalProperty(probe, "canonicalContainingFile") ??
        probe.containingFile;

      const resolvedPath = readOwnOptionalProperty(probe, "resolvedPath");

      const allowedRoots = validatedResolutionRoots(
        probe.allowedRoots,
        manifestRoots
      );

      if (
        allowedRoots === undefined ||
        (allowedRoots.length === 0 && resolvedPath !== undefined) ||
        canonicalEvidenceCandidatePath(probe.containingFile) !==
          canonicalContainingFile
      ) {
        return false;
      }

      const safeProbe: InstalledEvidenceResolutionProbe = {
        ...probe,
        ...(accessStyle !== undefined && { accessStyle }),
        canonicalContainingFile,
        ...(resolvedPath !== undefined && { resolvedPath }),
      };

      Object.setPrototypeOf(safeProbe, null);

      // Imports in the same directory share dependency visibility. Reuse the
      // lookup so large declaration graphs stay within the replay work budget.
      const searchRoots = cachedCompilerLookup(
        searchRootsByPackage,
        JSON.stringify([
          nodePath.dirname(safeProbe.containingFile),
          safeProbe.kind,
          parsePackageNameSegments(safeProbe.specifier),
        ]),
        () => resolutionSearchRoots(safeProbe, session)
      );

      return (
        (await session.resolveEvidenceProbe(safeProbe, [
          ...allowedRoots,
          ...searchRoots,
        ])) === resolvedPath
      );
    });
  } catch {
    return false;
  }
};

/** Replays cached resolutions and fingerprints against current Installed Evidence. */
export const installedEvidenceProofStillMatches =
  async function installedEvidenceProofStillMatches(
    cached: InstalledEvidenceProof,
    current: InstalledEvidenceProof
  ): Promise<boolean> {
    const owner = createCompilerSessionOwner();

    try {
      const session = createCompilerWorkSession({ owner });

      if (
        !currentManifestsMatch(cached, current) ||
        !fileChecksStillMatch(
          readOwnOptionalProperty(cached, "fileChecks") ?? [],
          session
        ) ||
        !fileFingerprintsStillMatch(cached.files) ||
        !directoryFingerprintsStillMatch(cached.directories)
      ) {
        return false;
      }

      const manifestRoots = new Set(
        cached.files
          .filter(
            ({ kind, path }) =>
              kind === "manifest" && nodePath.basename(path) === "package.json"
          )
          .map(({ path }) => nodePath.dirname(path))
      );

      return (
        sourceFormatsStillMatch(
          cached.files,
          cached.resolutions,
          manifestRoots,
          session
        ) &&
        (await resolutionProbesStillMatch(
          cached.resolutions,
          manifestRoots,
          session
        ))
      );
    } finally {
      await owner.close();
    }
  };
