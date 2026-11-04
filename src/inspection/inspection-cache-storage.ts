/* oxlint-disable anti-slop/no-unknown-parameters -- Cache envelopes and child-process receipts are untrusted disk/IPC data until their codecs validate them. */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Predicate, Schema } from "effect";

import { MAX_ANALYSIS_RESULT_BYTES } from "#typepeek/inspection/budget-policy";
import { readBoundedUtf8File } from "#typepeek/inspection/evidence-boundary";
import type {
  EncodedInspectionCacheIdentityValue,
  InspectionCacheEnvelope,
  InspectionCacheHitNotice,
  InspectionCacheIdentityValue,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/inspection-cache-codec";
import {
  CACHE_SCHEMA_VERSION,
  encodeInspectionCacheEnvelope,
  encodeInspectionCacheHitNotice,
  encodeInspectionCachePayload,
  encodeInspectionCacheWriteReceipt,
  MAX_CACHE_ENTRY_BYTES,
  readInspectionCacheEnvelope,
  readInspectionCacheHitNoticeMessage,
  readInspectionCacheKey,
  readInspectionCachePath,
  readInspectionCachePayload,
  readInspectionCacheWriteReceiptMessage,
} from "#typepeek/inspection/inspection-cache-codec";
import { enforceAnalysisRequestOutcome } from "#typepeek/inspection/inspection-outcome-authority";
import type { InspectableModuleSelection } from "#typepeek/inspection/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/installed-evidence-fingerprint";
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  InspectionOutcome,
  InspectionResult,
  InspectionResultIdentity,
} from "#typepeek/inspection/protocol";
import { readOwnOptionalProperty } from "#typepeek/inspection/untrusted-data";
import { bitwiseAnd } from "#typepeek/integer-bits";
import { decodeJson } from "#typepeek/json-data";
import { HAS_EMBEDDED_TYPEPEEK_VERSION } from "#typepeek/package-metadata";

const MAX_CACHE_DIRECTORY_ENTRIES = 256;

export type {
  InspectionCacheHitNotice,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/inspection-cache-codec";

export interface InspectionCacheIdentity {
  readonly key: string;
  readonly serialized: string;
  readonly value: EncodedInspectionCacheIdentityValue;
}

export interface ValidatedInspectionCachePayload {
  readonly identity: InspectionCacheIdentityValue;
  readonly outcome: InspectionOutcome;
  readonly proof: InstalledEvidenceProof;
}

/** Builds a bounded write receipt; the parent writes only after validating the outcome. */
export const createInspectionCacheWriteReceipt =
  function createInspectionCacheWriteReceipt(
    identity: InspectionCacheIdentity,
    proof: InstalledEvidenceProof | undefined
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

    return validated === undefined
      ? undefined
      : readInspectionCacheWriteReceiptMessage(validated);
  };

export const createInspectionCacheHitNotice =
  function createInspectionCacheHitNotice(
    identity: InspectionCacheIdentity
  ): InspectionCacheHitNotice | undefined {
    return encodeInspectionCacheHitNotice({
      key: identity.key,
      kind: "inspection-cache-hit",
    });
  };

export const readInspectionCacheHitNotice =
  function readInspectionCacheHitNotice(
    value: unknown
  ): InspectionCacheHitNotice | undefined {
    return readInspectionCacheHitNoticeMessage(value);
  };

const configuredCacheDirectory = function configuredCacheDirectory():
  | string
  | undefined {
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

  return nodePath.join(
    tmpdir(),
    `typepeek-${process.getuid?.() ?? "user"}`,
    `inspection-cache-v${CACHE_SCHEMA_VERSION}`
  );
};

const isPrivateOwned = function isPrivateOwned(metadata: Stats): boolean {
  const userId = process.getuid?.();

  return (
    (userId === undefined || metadata.uid === userId) &&
    bitwiseAnd(metadata.mode, 0o077) === 0
  );
};

const isPrivateOwnedDirectory = function isPrivateOwnedDirectory(
  metadata: Stats
): boolean {
  return metadata.isDirectory() && isPrivateOwned(metadata);
};

const isUsableCacheDirectory = function isUsableCacheDirectory(
  metadata: Stats
): boolean {
  return isPrivateOwnedDirectory(metadata) && !metadata.isSymbolicLink();
};

const prepareCacheDirectory = function prepareCacheDirectory(
  directory: string
): void {
  if (existsSync(directory)) {
    const metadata = lstatSync(directory);

    if (!isUsableCacheDirectory(metadata)) {
      throw new Error(
        "Inspection cache directory is not a private owned directory."
      );
    }

    return;
  }

  mkdirSync(directory, { mode: 0o700, recursive: true });
  const metadata = lstatSync(directory);

  if (!isUsableCacheDirectory(metadata)) {
    throw new Error(
      "Inspection cache directory could not be created privately."
    );
  }
};

const prepareAndReadCacheDirectory = function prepareAndReadCacheDirectory(
  directory: string,
  create: boolean
): string | undefined {
  try {
    if (create) {
      prepareCacheDirectory(directory);
    }

    const metadata = lstatSync(directory);

    return isUsableCacheDirectory(metadata) ? directory : undefined;
  } catch {
    return undefined;
  }
};

const cacheDirectory = function cacheDirectory(
  create: boolean
): string | undefined {
  const directory = configuredCacheDirectory();

  return directory === undefined
    ? undefined
    : prepareAndReadCacheDirectory(directory, create);
};

const cacheEntryPath = function cacheEntryPath(
  key: string,
  create: boolean
): string | undefined {
  const directory = cacheDirectory(create);

  return directory === undefined
    ? undefined
    : nodePath.join(directory, `${key}.json`);
};

export const removeInspectionCacheEntry = function removeInspectionCacheEntry(
  key: string
): void {
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
    /* Cache persistence and cleanup are best effort. */
  }
};

type CanonicalValue = Schema.Json | undefined | CanonicalCollection;

type CanonicalCollection = readonly CanonicalValue[] | CanonicalRecord;

interface CanonicalRecord {
  readonly [key: string]: CanonicalValue;
}

const isCanonicalArray = (
  value: CanonicalValue
): value is readonly CanonicalValue[] => Array.isArray(value);

const isCanonicalRecord = (value: CanonicalValue): value is CanonicalRecord =>
  Predicate.isReadonlyObject(value);

const canonicalValue = function canonicalValue(
  value: CanonicalValue
): CanonicalValue {
  if (isCanonicalArray(value)) {
    return value.map(canonicalValue);
  }

  if (isCanonicalRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => {
          const child = value[key];

          return [key, child === undefined ? undefined : canonicalValue(child)];
        })
    );
  }

  return value;
};

const stableJson = function stableJson(
  value: CanonicalValue
): string | undefined {
  return value === undefined
    ? undefined
    : JSON.stringify(canonicalValue(value));
};

const readWriteReceipt = function readWriteReceipt(
  value: unknown,
  request: AnalysisRequest
): InspectionCacheWriteReceipt | undefined {
  const receipt = readInspectionCacheWriteReceiptMessage(value);

  return receipt !== undefined &&
    stableJson(receipt.identity.request) === stableJson(request)
    ? receipt
    : undefined;
};

const resultKindMatchesEvidence = function resultKindMatchesEvidence(
  result: AtomicInspectionResult,
  evidenceKind: InspectableModuleSelection["kind"]
): boolean {
  const packageIdentity = readOwnOptionalProperty(result, "packageIdentity");

  return evidenceKind === "package"
    ? packageIdentity !== undefined
    : packageIdentity === undefined;
};

const resultIdentity = function resultIdentity(
  result: AtomicInspectionResult
): InspectionResultIdentity | undefined {
  const packageIdentity = readOwnOptionalProperty(result, "packageIdentity");

  const declarationProvider = readOwnOptionalProperty(
    result,
    "declarationProvider"
  );

  if (packageIdentity === undefined) {
    return declarationProvider === undefined
      ? undefined
      : { declarationProvider };
  }

  return {
    packageIdentity,
    ...(declarationProvider !== undefined && { declarationProvider }),
  };
};

const atomicResultMatchesCacheIdentity =
  function atomicResultMatchesCacheIdentity(
    result: AtomicInspectionResult,
    identity: InspectionCacheIdentityValue
  ): boolean {
    return (
      result.specifier === identity.request.request.specifier &&
      result.resolutionVariant.accessStyle ===
        identity.request.request.accessStyle &&
      resultKindMatchesEvidence(result, identity.evidence.kind) &&
      stableJson(resultIdentity(result)) ===
        stableJson(identity.evidence.resultIdentity)
    );
  };

const outcomeMatchesCacheIdentity = function outcomeMatchesCacheIdentity(
  result: InspectionResult,
  identity: InspectionCacheIdentityValue
): boolean {
  if (result.intent === "public-interface-comparison") {
    return false;
  }

  return result.intent === "inspection-plan"
    ? result.inspections.length > 0 &&
        result.inspections.every((inspection) =>
          atomicResultMatchesCacheIdentity(inspection, identity)
        )
    : atomicResultMatchesCacheIdentity(result, identity);
};

const digest = function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
};

export const identityFromValue = function identityFromValue(
  value: EncodedInspectionCacheIdentityValue
): InspectionCacheIdentity {
  const serialized = stableJson(value);

  if (serialized === undefined) {
    throw new TypeError("Inspection cache identities must serialize to JSON.");
  }

  return { key: digest(serialized), serialized, value };
};

const withCacheWriteLock = function withCacheWriteLock(
  directory: string,
  write: () => void
): void {
  const lockPath = nodePath.join(directory, ".write-lock");

  try {
    writeFileSync(lockPath, String(process.pid), {
      encoding: "utf-8",
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
      /* Cache persistence and cleanup are best effort. */
    }
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  }
};

const cacheDirectoryHasCapacity = function cacheDirectoryHasCapacity(
  entryPath: string
): boolean {
  if (existsSync(entryPath)) {
    return true;
  }

  const directory = opendirSync(nodePath.dirname(entryPath));
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
};

const isPrivateOwnedFile = function isPrivateOwnedFile(
  metadata: Stats
): boolean {
  return metadata.isFile() && isPrivateOwned(metadata);
};

const readIntegrityKey = function readIntegrityKey(
  directory: string,
  create: boolean
): string | undefined {
  const keyPath = nodePath.join(directory, ".integrity-key");

  if (create && !existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32).toString("hex"), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  }

  try {
    const metadata = lstatSync(keyPath);

    if (
      !isPrivateOwnedFile(metadata) ||
      metadata.isSymbolicLink() ||
      metadata.size !== 64
    ) {
      return undefined;
    }

    const key = readBoundedUtf8File(
      keyPath,
      64,
      "compiler-host-bytes",
      "Inspection cache integrity key exceeded its byte limit."
    );

    return readInspectionCacheKey(key);
  } catch {
    return undefined;
  }
};

const cacheIntegrity = function cacheIntegrity(
  key: string,
  payload: string
): string {
  return createHmac("sha256", key).update(payload).digest("hex");
};

const writeAtomically = function writeAtomically(
  path: string,
  serialized: string
): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  }
};

/** Stores a validated outcome by atomic rename within the cache limits. */
export const writeValidatedInspectionCacheOutcome =
  function writeValidatedInspectionCacheOutcome(
    request: AnalysisRequest,
    outcome: InspectionOutcome,
    value: unknown
  ): void {
    const authoritativeOutcome = enforceAnalysisRequestOutcome(
      request,
      outcome
    );

    if (authoritativeOutcome.status !== "success") {
      return;
    }

    const receipt = readWriteReceipt(value, request);

    if (
      receipt === undefined ||
      !outcomeMatchesCacheIdentity(
        authoritativeOutcome.result,
        receipt.identity
      )
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

    withCacheWriteLock(nodePath.dirname(path), () => {
      if (!cacheDirectoryHasCapacity(path)) {
        return;
      }

      const integrityKey = readIntegrityKey(nodePath.dirname(path), true);

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
  };

const isReadableCacheEntry = function isReadableCacheEntry(
  metadata: Stats
): boolean {
  return (
    isPrivateOwnedFile(metadata) &&
    !metadata.isSymbolicLink() &&
    metadata.size <= MAX_CACHE_ENTRY_BYTES
  );
};

const readCacheEnvelope = function readCacheEnvelope(
  path: string
): InspectionCacheEnvelope | undefined {
  const metadata = lstatSync(path);

  if (!isReadableCacheEntry(metadata)) {
    return undefined;
  }

  const value = decodeJson(
    Schema.Unknown,
    readBoundedUtf8File(
      path,
      MAX_CACHE_ENTRY_BYTES,
      "compiler-host-bytes",
      "Inspection cache entry exceeded its byte limit."
    )
  );

  return readInspectionCacheEnvelope(value);
};

const integritiesEqual = function integritiesEqual(
  left: string,
  right: string
): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const cacheEnvelopeIntegrityMatches = function cacheEnvelopeIntegrityMatches(
  envelope: InspectionCacheEnvelope,
  integrityKey: string
): boolean {
  return integritiesEqual(
    envelope.integrity,
    cacheIntegrity(integrityKey, envelope.payload)
  );
};

const readAuthenticatedCachePayload = function readAuthenticatedCachePayload(
  path: string,
  envelope: InspectionCacheEnvelope
): Schema.Json | undefined {
  const integrityKey = readIntegrityKey(nodePath.dirname(path), false);

  if (
    integrityKey === undefined ||
    !cacheEnvelopeIntegrityMatches(envelope, integrityKey)
  ) {
    return undefined;
  }

  return decodeJson(Schema.Json, envelope.payload);
};

const cacheIdentityMatches = function cacheIdentityMatches(
  candidate: InspectionCacheIdentityValue | undefined,
  expected: InspectionCacheIdentity
): candidate is InspectionCacheIdentityValue {
  return (
    candidate !== undefined && stableJson(candidate) === expected.serialized
  );
};

const readCachePayload = function readCachePayload(
  value: Schema.Json | undefined,
  identity: InspectionCacheIdentity
): ValidatedInspectionCachePayload | undefined {
  const payload = readInspectionCachePayload(value);

  if (
    payload === undefined ||
    !cacheIdentityMatches(payload.identity, identity)
  ) {
    return undefined;
  }

  const serializedOutcome = JSON.stringify(payload.outcome);

  if (Buffer.byteLength(serializedOutcome) > MAX_ANALYSIS_RESULT_BYTES) {
    return undefined;
  }

  const outcome = enforceAnalysisRequestOutcome(
    payload.identity.request,
    payload.outcome
  );

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
};

const readCacheEntry = function readCacheEntry(
  path: string,
  identity: InspectionCacheIdentity
): ValidatedInspectionCachePayload | undefined {
  try {
    const envelope = readCacheEnvelope(path);

    const payload =
      envelope === undefined
        ? undefined
        : readAuthenticatedCachePayload(path, envelope);

    return payload === undefined
      ? undefined
      : readCachePayload(payload, identity);
  } catch {
    return undefined;
  }
};

/** Returns a structurally validated candidate; the worker must replay its proof before reuse. */
export const readInspectionCacheCandidate =
  function readInspectionCacheCandidate(
    identity: InspectionCacheIdentity
  ): ValidatedInspectionCachePayload | undefined {
    const path = cacheEntryPath(identity.key, false);

    return path === undefined ? undefined : readCacheEntry(path, identity);
  };
