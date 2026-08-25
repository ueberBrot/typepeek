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
import { dirname, isAbsolute, join } from "node:path";

import {
  INSPECTION_BUDGET_POLICY_VERSION,
  MAX_ANALYSIS_RESULT_BYTES,
} from "#typepeek/inspection/budget-policy";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { canonicalEvidencePath, readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
import type { InspectableModuleSelection } from "#typepeek/inspection/installed-evidence";
import {
  type InstalledEvidenceDirectoryFingerprint,
  type InstalledEvidenceFingerprint,
  type InstalledEvidenceProof,
  type InstalledEvidenceResolutionProbe,
  MAX_FINGERPRINTED_DIRECTORIES,
  MAX_FINGERPRINTED_DIRECTORY_ENTRIES,
  MAX_FINGERPRINTED_FILES,
  MAX_RESOLUTION_PROBES,
  readInstalledEvidenceDirectoryFingerprint,
  sha256,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  InspectionOutcome,
  InspectionResult,
  InspectionResultIdentity,
  PackageIdentity,
} from "#typepeek/inspection/protocol";
import { readAnalysisRequest } from "#typepeek/inspection/request-codec";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";
import { HAS_EMBEDDED_TYPEPEEK_VERSION } from "#typepeek/package-metadata";

const CACHE_SCHEMA_VERSION = 1;
const INSPECTION_CACHE_SEMANTICS_VERSION = "2";
const MAX_CACHE_DIRECTORY_ENTRIES = 256;
const MAX_CACHE_ENTRY_BYTES = 160 * 1_024;
const MAX_CACHE_RECEIPT_BYTES = 96 * 1_024;
const MAX_CACHE_EVIDENCE_BYTES = 12 * 1_024 * 1_024;
const MAX_CACHE_PATH_BYTES = 4 * 1_024;
const SHA256_PATTERN = /^[\da-f]{64}$/u;

export interface InspectionCacheIdentityValue {
  readonly budgetVersion: typeof INSPECTION_BUDGET_POLICY_VERSION;
  readonly cacheSemanticsVersion: typeof INSPECTION_CACHE_SEMANTICS_VERSION;
  readonly compilerVersion: string;
  readonly evidence: {
    readonly declarationPath: string;
    readonly declarationRoot: string;
    readonly kind: InspectableModuleSelection["kind"];
    readonly repositoryRoot: string;
    readonly resolutionContextDirectory: string;
    readonly resultIdentity: InspectionResultIdentity;
  };
  readonly request: AnalysisRequest;
  readonly typepeekVersion: typeof TYPEPEEK_VERSION;
}

export interface InspectionCacheIdentity {
  readonly key: string;
  readonly serialized: string;
  readonly value: InspectionCacheIdentityValue;
}

export interface InspectionCacheWriteReceipt {
  readonly identity: InspectionCacheIdentityValue;
  readonly kind: "inspection-cache-write";
  readonly proof: InstalledEvidenceProof;
}

export interface InspectionCacheHitNotice {
  readonly key: string;
  readonly kind: "inspection-cache-hit";
}

interface InspectionCachePayload {
  readonly identity: InspectionCacheIdentityValue;
  readonly outcome: InspectionOutcome;
  readonly proof: InstalledEvidenceProof;
}

interface InspectionCacheEnvelope {
  readonly integrity: string;
  readonly payload: string;
}

/** Creates the complete non-content portion of one cache key after bounded resolution. */
export function createInspectionCacheIdentity(
  request: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionCacheIdentity {
  const value: InspectionCacheIdentityValue = {
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
  const receipt: InspectionCacheWriteReceipt = {
    identity: identity.value,
    kind: "inspection-cache-write",
    proof,
  };
  return Buffer.byteLength(JSON.stringify(receipt)) <= MAX_CACHE_RECEIPT_BYTES
    ? receipt
    : undefined;
}

export function createInspectionCacheHitNotice(
  identity: InspectionCacheIdentity,
): InspectionCacheHitNotice {
  return { key: identity.key, kind: "inspection-cache-hit" };
}

export function readInspectionCacheHitNotice(value: unknown): InspectionCacheHitNotice | undefined {
  return isRecord(value) && value["kind"] === "inspection-cache-hit" && isCacheKey(value["key"])
    ? { key: value["key"], kind: "inspection-cache-hit" }
    : undefined;
}

export function removeInspectionCacheEntry(key: string): void {
  if (!isCacheKey(key)) {
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
  if (outcome.status !== "success") {
    return;
  }
  const receipt = readWriteReceipt(value, request);
  if (receipt === undefined || !outcomeMatchesCacheIdentity(outcome.result, receipt.identity)) {
    return;
  }
  const identity = identityFromValue(receipt.identity);
  const payload: InspectionCachePayload = {
    identity: receipt.identity,
    outcome,
    proof: receipt.proof,
  };
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
    const serialized = JSON.stringify({
      integrity: cacheIntegrity(integrityKey, serializedPayload),
      payload: serializedPayload,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });
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
  return evidenceKind === "package"
    ? result.packageIdentity !== undefined
    : result.packageIdentity === undefined;
}

function resultIdentity(result: AtomicInspectionResult): InspectionResultIdentity | undefined {
  if (result.packageIdentity === undefined) {
    return result.declarationProvider === undefined
      ? undefined
      : { declarationProvider: result.declarationProvider };
  }
  return {
    packageIdentity: result.packageIdentity,
    ...(result.declarationProvider === undefined
      ? {}
      : { declarationProvider: result.declarationProvider }),
  };
}

function readCacheEntry(
  path: string,
  identity: InspectionCacheIdentity,
): InspectionCachePayload | undefined {
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
  return parseCacheEnvelope(value);
}

function isReadableCacheEntry(metadata: Stats): boolean {
  return (
    isPrivateOwnedFile(metadata) &&
    !metadata.isSymbolicLink() &&
    metadata.size <= MAX_CACHE_ENTRY_BYTES
  );
}

function parseCacheEnvelope(value: unknown): InspectionCacheEnvelope | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== CACHE_SCHEMA_VERSION) {
    return undefined;
  }
  const payload = readBoundedCachePayload(value["payload"]);
  const integrity = readSha256(value["integrity"]);
  return payload === undefined || integrity === undefined ? undefined : { integrity, payload };
}

function readBoundedCachePayload(value: unknown): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value) <= MAX_CACHE_ENTRY_BYTES
    ? value
    : undefined;
}

function readSha256(value: unknown): string | undefined {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : undefined;
}

function readAuthenticatedCachePayload(
  path: string,
  envelope: InspectionCacheEnvelope,
): Readonly<Record<string, unknown>> | undefined {
  const integrityKey = readIntegrityKey(dirname(path), false);
  if (integrityKey === undefined || !cacheEnvelopeIntegrityMatches(envelope, integrityKey)) {
    return undefined;
  }
  const payload = JSON.parse(envelope.payload) as unknown;
  return isRecord(payload) ? payload : undefined;
}

function cacheEnvelopeIntegrityMatches(
  envelope: InspectionCacheEnvelope,
  integrityKey: string,
): boolean {
  return integritiesEqual(envelope.integrity, cacheIntegrity(integrityKey, envelope.payload));
}

function readCachePayload(
  payload: Readonly<Record<string, unknown>>,
  identity: InspectionCacheIdentity,
): InspectionCachePayload | undefined {
  const candidateIdentity = readIdentity(payload["identity"]);
  const proof = readProof(payload["proof"]);
  const outcome = readCachedSuccessOutcome(payload["outcome"]);
  if (!cacheIdentityMatches(candidateIdentity, identity)) {
    return undefined;
  }
  if (
    proof === undefined ||
    outcome === undefined ||
    !outcomeMatchesCacheIdentity(outcome.result, candidateIdentity)
  ) {
    return undefined;
  }
  return {
    identity: candidateIdentity,
    outcome,
    proof,
  };
}

function readCachedSuccessOutcome(
  value: unknown,
): { readonly status: "success"; readonly result: InspectionResult } | undefined {
  if (!isRecord(value) || value["status"] !== "success" || !isRecord(value["result"])) {
    return undefined;
  }
  const outcome = { status: "success", result: value["result"] as InspectionResult } as const;
  return Buffer.byteLength(JSON.stringify(outcome)) <= MAX_ANALYSIS_RESULT_BYTES
    ? outcome
    : undefined;
}

function cacheIdentityMatches(
  candidate: InspectionCacheIdentityValue | undefined,
  expected: InspectionCacheIdentity,
): candidate is InspectionCacheIdentityValue {
  return candidate !== undefined && stableJson(candidate) === expected.serialized;
}

function evidenceStillMatches(
  entry: InspectionCachePayload,
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
  if (!isRecord(value) || value["kind"] !== "inspection-cache-write") {
    return undefined;
  }
  const identity = readIdentity(value["identity"]);
  const proof = readProof(value["proof"]);
  if (
    identity === undefined ||
    proof === undefined ||
    stableJson(identity.request) !== stableJson(request)
  ) {
    return undefined;
  }
  const receipt: InspectionCacheWriteReceipt = {
    identity,
    kind: "inspection-cache-write",
    proof,
  };
  return Buffer.byteLength(JSON.stringify(receipt)) <= MAX_CACHE_RECEIPT_BYTES
    ? receipt
    : undefined;
}

function readIdentity(value: unknown): InspectionCacheIdentityValue | undefined {
  if (!isRecord(value) || !cacheIdentityVersionsMatch(value)) {
    return undefined;
  }
  const evidence = readCacheEvidenceIdentity(value["evidence"]);
  const requestReading = readAnalysisRequest(value["request"]);
  if (evidence === undefined || !requestReading.accepted) {
    return undefined;
  }
  return {
    budgetVersion: INSPECTION_BUDGET_POLICY_VERSION,
    cacheSemanticsVersion: INSPECTION_CACHE_SEMANTICS_VERSION,
    compilerVersion: ts.version,
    evidence,
    request: requestReading.request,
    typepeekVersion: TYPEPEEK_VERSION,
  };
}

function cacheIdentityVersionsMatch(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value["budgetVersion"] === INSPECTION_BUDGET_POLICY_VERSION &&
    value["cacheSemanticsVersion"] === INSPECTION_CACHE_SEMANTICS_VERSION &&
    value["compilerVersion"] === ts.version &&
    value["typepeekVersion"] === TYPEPEEK_VERSION
  );
}

function readCacheEvidenceIdentity(
  value: unknown,
): InspectionCacheIdentityValue["evidence"] | undefined {
  if (!isRecord(value) || (value["kind"] !== "package" && value["kind"] !== "platform")) {
    return undefined;
  }
  const declarationPath = readBoundedAbsolutePath(value["declarationPath"]);
  const declarationRoot = readBoundedAbsolutePath(value["declarationRoot"]);
  const repositoryRoot = readBoundedAbsolutePath(value["repositoryRoot"]);
  const resolutionContextDirectory = readBoundedAbsolutePath(value["resolutionContextDirectory"]);
  const resultIdentity = readResultIdentity(value["resultIdentity"]);
  if (
    declarationPath === undefined ||
    declarationRoot === undefined ||
    repositoryRoot === undefined ||
    resolutionContextDirectory === undefined ||
    resultIdentity === undefined
  ) {
    return undefined;
  }
  return {
    declarationPath,
    declarationRoot,
    kind: value["kind"],
    repositoryRoot,
    resolutionContextDirectory,
    resultIdentity,
  };
}

function readResultIdentity(value: unknown): InspectionResultIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const packageIdentity = readPackageIdentity(value["packageIdentity"]);
  const declarationProvider = readPackageIdentity(value["declarationProvider"]);
  if (packageIdentity === undefined && declarationProvider === undefined) {
    return undefined;
  }
  return packageIdentity === undefined
    ? { declarationProvider: declarationProvider as PackageIdentity }
    : {
        packageIdentity,
        ...(declarationProvider === undefined ? {} : { declarationProvider }),
      };
}

function readPackageIdentity(value: unknown): PackageIdentity | undefined {
  if (!isRecord(value) || !boundedString(value["name"])) {
    return undefined;
  }
  const version = value["version"];
  return version === undefined
    ? { name: value["name"] }
    : boundedString(version)
      ? { name: value["name"], version }
      : undefined;
}

function readEvidence(value: unknown): readonly InstalledEvidenceFingerprint[] | undefined {
  return readBoundedArray(value, MAX_FINGERPRINTED_FILES, readEvidenceFingerprint);
}

function readEvidenceFingerprint(value: unknown): InstalledEvidenceFingerprint | undefined {
  if (!isRecord(value) || (value["kind"] !== "declaration" && value["kind"] !== "manifest")) {
    return undefined;
  }
  const path = readBoundedAbsolutePath(value["path"]);
  const fingerprint = readSha256(value["sha256"]);
  return path === undefined || fingerprint === undefined
    ? undefined
    : { kind: value["kind"], path, sha256: fingerprint };
}

function readProof(value: unknown): InstalledEvidenceProof | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const directories = readDirectoryFingerprints(value["directories"]);
  const files = readEvidence(value["files"]);
  const resolutions = readResolutionProbes(value["resolutions"]);
  return directories === undefined || files === undefined || resolutions === undefined
    ? undefined
    : { directories, files, resolutions };
}

function readDirectoryFingerprints(
  value: unknown,
): readonly InstalledEvidenceDirectoryFingerprint[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FINGERPRINTED_DIRECTORIES) {
    return undefined;
  }
  const directories: InstalledEvidenceDirectoryFingerprint[] = [];
  let entryCount = 0;
  for (const candidate of value) {
    const directory = readDirectoryFingerprint(candidate);
    if (directory === undefined) {
      return undefined;
    }
    entryCount += directory.entries;
    if (entryCount > MAX_FINGERPRINTED_DIRECTORY_ENTRIES) {
      return undefined;
    }
    directories.push(directory);
  }
  return directories;
}

function readDirectoryFingerprint(
  value: unknown,
): InstalledEvidenceDirectoryFingerprint | undefined {
  if (!isRecord(value) || !isNonnegativeInteger(value["entries"])) {
    return undefined;
  }
  const path = readBoundedAbsolutePath(value["path"]);
  const fingerprint = readSha256(value["sha256"]);
  return path === undefined || fingerprint === undefined
    ? undefined
    : { entries: value["entries"], path, sha256: fingerprint };
}

function readResolutionProbes(
  value: unknown,
): readonly InstalledEvidenceResolutionProbe[] | undefined {
  return readBoundedArray(value, MAX_RESOLUTION_PROBES, readResolutionProbe);
}

function readResolutionProbe(value: unknown): InstalledEvidenceResolutionProbe | undefined {
  const probe = readResolutionProbeRecord(value);
  if (probe === undefined) {
    return undefined;
  }
  const required = readResolutionProbeRequiredFields(probe.record);
  const optional = readResolutionProbeOptionalFields(probe.record);
  if (required === undefined || optional === undefined) {
    return undefined;
  }
  return {
    kind: probe.kind,
    ...required,
    ...optional,
  };
}

function readResolutionProbeRecord(value: unknown):
  | {
      readonly kind: InstalledEvidenceResolutionProbe["kind"];
      readonly record: Readonly<Record<string, unknown>>;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = readResolutionProbeKind(value["kind"]);
  return kind === undefined ? undefined : { kind, record: value };
}

function readResolutionProbeKind(
  value: unknown,
): InstalledEvidenceResolutionProbe["kind"] | undefined {
  switch (value) {
    case "module":
    case "type-reference":
      return value;
    default:
      return undefined;
  }
}

function readResolutionProbeRequiredFields(
  value: Readonly<Record<string, unknown>>,
): Pick<InstalledEvidenceResolutionProbe, "containingFile" | "specifier"> | undefined {
  const containingFile = readBoundedAbsolutePath(value["containingFile"]);
  const specifier = readBoundedString(value["specifier"]);
  return containingFile === undefined || specifier === undefined
    ? undefined
    : { containingFile, specifier };
}

function readResolutionProbeOptionalFields(
  value: Readonly<Record<string, unknown>>,
): Pick<InstalledEvidenceResolutionProbe, "accessStyle" | "resolvedPath"> | undefined {
  const resolvedPath = readOptionalBoundedAbsolutePath(value["resolvedPath"]);
  const accessStyle = readOptionalAccessStyle(value["accessStyle"]);
  if (resolvedPath === false || accessStyle === false) {
    return undefined;
  }
  return {
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    ...(accessStyle === undefined ? {} : { accessStyle }),
  };
}

function resolutionProbesStillMatch(probes: readonly InstalledEvidenceResolutionProbe[]): boolean {
  try {
    const session = createCompilerWorkSession();
    return probes.every((probe) => session.resolveEvidenceProbe(probe) === probe.resolvedPath);
  } catch {
    return false;
  }
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
    return boundedAbsolutePath(explicit) && explicit.length > 0 ? explicit : undefined;
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
    return SHA256_PATTERN.test(key) ? key : undefined;
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

function boundedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_CACHE_PATH_BYTES &&
    isAbsolute(value)
  );
}

function readBoundedAbsolutePath(value: unknown): string | undefined {
  return boundedAbsolutePath(value) ? value : undefined;
}

function readOptionalBoundedAbsolutePath(value: unknown): string | undefined | false {
  return value === undefined ? undefined : (readBoundedAbsolutePath(value) ?? false);
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= MAX_CACHE_PATH_BYTES;
}

function readBoundedString(value: unknown): string | undefined {
  return boundedString(value) ? value : undefined;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readOptionalAccessStyle(value: unknown): "import" | "require" | undefined | false {
  if (value === undefined || value === "import" || value === "require") {
    return value;
  }
  return false;
}

function readBoundedArray<Value>(
  value: unknown,
  maximumItems: number,
  readItem: (candidate: unknown) => Value | undefined,
): readonly Value[] | undefined {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return undefined;
  }
  const items: Value[] = [];
  for (const candidate of value) {
    const item = readItem(candidate);
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return items;
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

function isCacheKey(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
