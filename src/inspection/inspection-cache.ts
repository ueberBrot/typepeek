import ts from "@typescript/typescript6";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  INSPECTION_BUDGET_POLICY_VERSION,
  MAX_ANALYSIS_RESULT_BYTES,
} from "#typepeek/inspection/budget-policy";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { canonicalEvidencePath, readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
import {
  CACHE_SCHEMA_VERSION,
  type InspectionCacheEnvelope,
  type InspectionCacheHitNotice,
  type InspectionCacheIdentityValue,
  type InspectionCacheWriteReceipt,
  INSPECTION_CACHE_SEMANTICS_VERSION,
  MAX_CACHE_ENTRY_BYTES,
  readInspectionCacheEnvelope,
  readInspectionCacheHitNoticeMessage,
  readInspectionCacheKey,
  readInspectionCachePath,
  readInspectionCachePayload,
  readInspectionCacheWriteReceiptMessage,
  encodeInspectionCacheEnvelope,
  encodeInspectionCacheHitNotice,
  encodeInspectionCacheIdentityValue,
  encodeInspectionCachePayload,
  encodeInspectionCacheWriteReceipt,
} from "#typepeek/inspection/inspection-cache-codec";
import type { InspectableModuleSelection } from "#typepeek/inspection/installed-evidence";
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
  enforceAnalysisRequestOutcome,
  type AnalysisRequest,
  type AtomicInspectionResult,
  type InspectionOutcome,
  type InspectionResult,
  type InspectionResultIdentity,
} from "#typepeek/inspection/protocol";
import { readOwnDataProperty } from "#typepeek/inspection/untrusted-data";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";
import { HAS_EMBEDDED_TYPEPEEK_VERSION } from "#typepeek/package-metadata";

const MAX_CACHE_DIRECTORY_ENTRIES = 256;
const MAX_CACHE_EVIDENCE_BYTES = 12 * 1_024 * 1_024;

export type {
  InspectionCacheHitNotice,
  InspectionCacheIdentityValue,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/inspection-cache-codec";

export interface InspectionCacheIdentity {
  readonly key: string;
  readonly serialized: string;
  readonly value: InspectionCacheIdentityValue;
}

interface ValidatedInspectionCachePayload {
  readonly identity: InspectionCacheIdentityValue;
  readonly outcome: InspectionOutcome;
  readonly proof: InstalledEvidenceProof;
}

/** Creates the complete non-content portion of one cache key after bounded resolution. */
export function createInspectionCacheIdentity(
  request: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionCacheIdentity | undefined {
  const candidate = {
    budgetVersion: INSPECTION_BUDGET_POLICY_VERSION,
    cacheSemanticsVersion: INSPECTION_CACHE_SEMANTICS_VERSION,
    compilerVersion: ts.version,
    evidence: {
      declarationPath: selection.declarationPath,
      declarationRoot: selection.declarationRoot,
      kind: selection.kind,
      repositoryRoot: selection.repositoryRoot,
      resolutionContextDirectory: selection.resolutionContextDirectory,
      resultIdentity: selection.resultIdentity,
    },
    request,
    typepeekVersion: TYPEPEEK_VERSION,
  };
  const value = encodeInspectionCacheIdentityValue(candidate);
  if (value === undefined) {
    return undefined;
  }
  const serialized = stableJson(value);
  return { key: digest(serialized), serialized, value };
}

/** Reads an untrusted candidate only after its complete evidence proof still matches. */
export function readInspectionCacheOutcome(
  identity: InspectionCacheIdentity,
  currentSelectionProof: InstalledEvidenceProof,
): InspectionOutcome | undefined {
  const path = cacheEntryPath(identity.key, false);
  if (path === undefined) {
    return undefined;
  }
  const entry = readCacheEntry(path, identity);
  return entry !== undefined && evidenceStillMatches(entry, currentSelectionProof)
    ? entry.outcome
    : undefined;
}

/** Builds a bounded write receipt; the parent writes only after validating the outcome. */
export function createInspectionCacheWriteReceipt(
  identity: InspectionCacheIdentity,
  proof: InstalledEvidenceProof | undefined,
): InspectionCacheWriteReceipt | undefined {
  if (proof === undefined) {
    return undefined;
  }
  const receipt = {
    identity: identity.value,
    kind: "inspection-cache-write",
    proof,
  };
  const validated = encodeInspectionCacheWriteReceipt(receipt);
  return validated === undefined ? undefined : readInspectionCacheWriteReceiptMessage(validated);
}

export function createInspectionCacheHitNotice(
  identity: InspectionCacheIdentity,
): InspectionCacheHitNotice | undefined {
  return encodeInspectionCacheHitNotice({ key: identity.key, kind: "inspection-cache-hit" });
}

export function readInspectionCacheHitNotice(value: unknown): InspectionCacheHitNotice | undefined {
  return readInspectionCacheHitNoticeMessage(value);
}

export function removeInspectionCacheEntry(key: string): void {
  if (readInspectionCacheKey(key) === undefined) {
    return;
  }
  const path = cacheEntryPath(key, false);
  if (path === undefined) {
    return;
  }
  try {
    const metadata = lstatSync(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      unlinkSync(path);
    }
  } catch {
    // A cache entry is optional and may disappear concurrently.
  }
}

/** Persists one already validated complete outcome behind bounded, atomic storage. */
export function writeValidatedInspectionCacheOutcome(
  request: AnalysisRequest,
  outcome: InspectionOutcome,
  value: unknown,
): void {
  const authoritativeOutcome = enforceAnalysisRequestOutcome(request, outcome);
  if (authoritativeOutcome.status !== "success") {
    return;
  }
  const receipt = readWriteReceipt(value, request);
  if (
    receipt === undefined ||
    !outcomeMatchesCacheIdentity(authoritativeOutcome.result, receipt.identity)
  ) {
    return;
  }
  const identity = identityFromValue(receipt.identity);
  const payload = encodeInspectionCachePayload({
    identity: receipt.identity,
    outcome: authoritativeOutcome,
    proof: receipt.proof,
  });
  if (payload === undefined) {
    return;
  }
  const path = cacheEntryPath(identity.key, true);
  if (path === undefined) {
    return;
  }
  withCacheWriteLock(dirname(path), () => {
    if (!cacheDirectoryHasCapacity(path)) {
      return;
    }
    const integrityKey = readIntegrityKey(dirname(path), true);
    if (integrityKey === undefined) {
      return;
    }
    const serializedPayload = JSON.stringify(payload);
    const envelope = encodeInspectionCacheEnvelope({
      integrity: cacheIntegrity(integrityKey, serializedPayload),
      payload: serializedPayload,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });
    if (envelope === undefined) {
      return;
    }
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > MAX_CACHE_ENTRY_BYTES) {
      return;
    }
    writeAtomically(path, serialized);
  });
}

function outcomeMatchesCacheIdentity(
  result: InspectionResult,
  identity: InspectionCacheIdentityValue,
): boolean {
  if (result.intent === "public-interface-comparison") {
    return false;
  }
  return result.intent === "inspection-plan"
    ? result.inspections.length > 0 &&
        result.inspections.every((inspection) =>
          atomicResultMatchesCacheIdentity(inspection, identity),
        )
    : atomicResultMatchesCacheIdentity(result, identity);
}

function atomicResultMatchesCacheIdentity(
  result: AtomicInspectionResult,
  identity: InspectionCacheIdentityValue,
): boolean {
  return (
    result.specifier === identity.request.request.specifier &&
    result.resolutionVariant.accessStyle === identity.request.request.accessStyle &&
    resultKindMatchesEvidence(result, identity.evidence.kind) &&
    stableJson(resultIdentity(result)) === stableJson(identity.evidence.resultIdentity)
  );
}

function resultKindMatchesEvidence(
  result: AtomicInspectionResult,
  evidenceKind: InspectableModuleSelection["kind"],
): boolean {
  const packageIdentity = readOwnOptionalProperty(result, "packageIdentity");
  return evidenceKind === "package" ? packageIdentity !== undefined : packageIdentity === undefined;
}

function resultIdentity(result: AtomicInspectionResult): InspectionResultIdentity | undefined {
  const packageIdentity = readOwnOptionalProperty(result, "packageIdentity");
  const declarationProvider = readOwnOptionalProperty(result, "declarationProvider");
  if (packageIdentity === undefined) {
    return declarationProvider === undefined ? undefined : { declarationProvider };
  }
  return {
    packageIdentity,
    ...(declarationProvider === undefined ? {} : { declarationProvider }),
  };
}

function readCacheEntry(
  path: string,
  identity: InspectionCacheIdentity,
): ValidatedInspectionCachePayload | undefined {
  try {
    const envelope = readCacheEnvelope(path);
    const payload =
      envelope === undefined ? undefined : readAuthenticatedCachePayload(path, envelope);
    return payload === undefined ? undefined : readCachePayload(payload, identity);
  } catch {
    return undefined;
  }
}

function readCacheEnvelope(path: string): InspectionCacheEnvelope | undefined {
  const metadata = lstatSync(path);
  if (!isReadableCacheEntry(metadata)) {
    return undefined;
  }
  const value = JSON.parse(
    readBoundedUtf8File(
      path,
      MAX_CACHE_ENTRY_BYTES,
      "compiler-host-bytes",
      "Inspection cache entry exceeded its byte limit.",
    ),
  ) as unknown;
  return readInspectionCacheEnvelope(value);
}

function isReadableCacheEntry(metadata: Stats): boolean {
  return (
    isPrivateOwnedFile(metadata) &&
    !metadata.isSymbolicLink() &&
    metadata.size <= MAX_CACHE_ENTRY_BYTES
  );
}

function readAuthenticatedCachePayload(path: string, envelope: InspectionCacheEnvelope): unknown {
  const integrityKey = readIntegrityKey(dirname(path), false);
  if (integrityKey === undefined || !cacheEnvelopeIntegrityMatches(envelope, integrityKey)) {
    return undefined;
  }
  return JSON.parse(envelope.payload) as unknown;
}

function cacheEnvelopeIntegrityMatches(
  envelope: InspectionCacheEnvelope,
  integrityKey: string,
): boolean {
  return integritiesEqual(envelope.integrity, cacheIntegrity(integrityKey, envelope.payload));
}

function readCachePayload(
  value: unknown,
  identity: InspectionCacheIdentity,
): ValidatedInspectionCachePayload | undefined {
  const payload = readInspectionCachePayload(value);
  if (payload === undefined || !cacheIdentityMatches(payload.identity, identity)) {
    return undefined;
  }
  const serializedOutcome = JSON.stringify(payload.outcome);
  if (Buffer.byteLength(serializedOutcome) > MAX_ANALYSIS_RESULT_BYTES) {
    return undefined;
  }
  const outcome = enforceAnalysisRequestOutcome(payload.identity.request, payload.outcome);
  if (
    outcome.status !== "success" ||
    !outcomeMatchesCacheIdentity(outcome.result, payload.identity)
  ) {
    return undefined;
  }
  return {
    identity: payload.identity,
    outcome,
    proof: payload.proof,
  };
}

function cacheIdentityMatches(
  candidate: InspectionCacheIdentityValue | undefined,
  expected: InspectionCacheIdentity,
): candidate is InspectionCacheIdentityValue {
  return candidate !== undefined && stableJson(candidate) === expected.serialized;
}

function evidenceStillMatches(
  entry: ValidatedInspectionCachePayload,
  currentSelectionProof: InstalledEvidenceProof,
): boolean {
  return (
    currentManifestsMatch(entry.proof, currentSelectionProof) &&
    resolutionProbesStillMatch(entry.proof.resolutions) &&
    directoryFingerprintsStillMatch(entry.proof.directories) &&
    fileFingerprintsStillMatch(entry.proof.files)
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
      MAX_CACHE_EVIDENCE_BYTES - consumedBytes,
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

function readWriteReceipt(
  value: unknown,
  request: AnalysisRequest,
): InspectionCacheWriteReceipt | undefined {
  const receipt = readInspectionCacheWriteReceiptMessage(value);
  return receipt !== undefined && stableJson(receipt.identity.request) === stableJson(request)
    ? receipt
    : undefined;
}

function resolutionProbesStillMatch(probes: readonly InstalledEvidenceResolutionProbe[]): boolean {
  try {
    const session = createCompilerWorkSession();
    return probes.every((probe) => {
      const accessStyle = readOwnOptionalProperty(probe, "accessStyle");
      const resolvedPath = readOwnOptionalProperty(probe, "resolvedPath");
      const safeProbe = Object.assign(Object.create(null), probe, {
        accessStyle,
        resolvedPath,
      }) as InstalledEvidenceResolutionProbe;
      return session.resolveEvidenceProbe(safeProbe) === resolvedPath;
    });
  } catch {
    return false;
  }
}

function readOwnOptionalProperty<Value extends object, Key extends keyof Value & string>(
  value: Value,
  key: Key,
): Value[Key] | undefined {
  const entry = readOwnDataProperty(value, key);
  return entry?.[1] as Value[Key] | undefined;
}

function identityFromValue(value: InspectionCacheIdentityValue): InspectionCacheIdentity {
  const serialized = stableJson(value);
  return { key: digest(serialized), serialized, value };
}

function cacheEntryPath(key: string, create: boolean): string | undefined {
  const directory = cacheDirectory(create);
  return directory === undefined ? undefined : join(directory, `${key}.json`);
}

function cacheDirectory(create: boolean): string | undefined {
  const directory = configuredCacheDirectory();
  return directory === undefined ? undefined : prepareAndReadCacheDirectory(directory, create);
}

function configuredCacheDirectory(): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  const explicit = process.env["TYPEPEEK_CACHE_DIRECTORY"];
  if (explicit !== undefined) {
    return readInspectionCachePath(explicit);
  }
  if (process.env["NODE_ENV"] === "test" || !HAS_EMBEDDED_TYPEPEEK_VERSION) {
    return undefined;
  }
  return join(
    tmpdir(),
    `typepeek-${process.getuid?.() ?? "user"}`,
    `inspection-cache-v${CACHE_SCHEMA_VERSION}`,
  );
}

function prepareAndReadCacheDirectory(directory: string, create: boolean): string | undefined {
  try {
    if (create) {
      prepareCacheDirectory(directory);
    }
    const metadata = lstatSync(directory);
    return isUsableCacheDirectory(metadata) ? directory : undefined;
  } catch {
    return undefined;
  }
}

function prepareCacheDirectory(directory: string): void {
  if (existsSync(directory)) {
    const metadata = lstatSync(directory);
    if (!isUsableCacheDirectory(metadata)) {
      throw new Error("Inspection cache directory is not a private owned directory.");
    }
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!isUsableCacheDirectory(metadata)) {
    throw new Error("Inspection cache directory could not be created privately.");
  }
}

function isUsableCacheDirectory(metadata: Stats): boolean {
  return isPrivateOwnedDirectory(metadata) && !metadata.isSymbolicLink();
}

function cacheDirectoryHasCapacity(entryPath: string): boolean {
  if (existsSync(entryPath)) {
    return true;
  }
  const directory = opendirSync(dirname(entryPath));
  let count = 0;
  try {
    while (directory.readSync() !== null) {
      count += 1;
      if (count >= MAX_CACHE_DIRECTORY_ENTRIES) {
        return false;
      }
    }
    return true;
  } finally {
    directory.closeSync();
  }
}

function writeAtomically(path: string, serialized: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cache writes never change inspection authority.
    }
  }
}

function withCacheWriteLock(directory: string, write: () => void): void {
  const lockPath = join(directory, ".write-lock");
  try {
    writeFileSync(lockPath, String(process.pid), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    return;
  }
  try {
    try {
      write();
    } catch {
      // Optional cache storage must never change an Inspection Outcome.
    }
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // A lost best-effort lock can only disable later cache writes.
    }
  }
}

function readIntegrityKey(directory: string, create: boolean): string | undefined {
  const keyPath = join(directory, ".integrity-key");
  if (create && !existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32).toString("hex"), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // A concurrent writer may have created the same private key.
    }
  }
  try {
    const metadata = lstatSync(keyPath);
    if (!isPrivateOwnedFile(metadata) || metadata.isSymbolicLink() || metadata.size !== 64) {
      return undefined;
    }
    const key = readBoundedUtf8File(
      keyPath,
      64,
      "compiler-host-bytes",
      "Inspection cache integrity key exceeded its byte limit.",
    );
    return readInspectionCacheKey(key);
  } catch {
    return undefined;
  }
}

function isPrivateOwnedDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && isPrivateOwned(metadata);
}

function isPrivateOwnedFile(metadata: Stats): boolean {
  return metadata.isFile() && isPrivateOwned(metadata);
}

function isPrivateOwned(metadata: Stats): boolean {
  const userId = process.getuid?.();
  return (userId === undefined || metadata.uid === userId) && (metadata.mode & 0o077) === 0;
}

function cacheIntegrity(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

function integritiesEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
