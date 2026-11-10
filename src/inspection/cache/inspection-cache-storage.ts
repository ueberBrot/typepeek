/* oxlint-disable anti-slop/no-unknown-parameters -- Child-process cache receipts are untrusted IPC data until their codecs validate them. */
import { createHash } from "node:crypto";

import type { Schema } from "effect";
import { Predicate } from "effect";

import type {
  EncodedInspectionCacheIdentityValue,
  InspectionCacheHitNotice,
  InspectionCacheIdentityValue,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/cache/inspection-cache-codec";
import {
  encodeInspectionCacheHitNotice,
  encodeInspectionCachePayload,
  encodeInspectionCacheWriteReceipt,
  readInspectionCacheHitNoticeMessage,
  readInspectionCachePayload,
  readInspectionCacheWriteReceiptMessage,
} from "#typepeek/inspection/cache/inspection-cache-codec";
import {
  readAuthenticatedInspectionCacheFile,
  writeInspectionCacheFile,
} from "#typepeek/inspection/cache/inspection-cache-files";
import type { InspectableModuleSelection } from "#typepeek/inspection/evidence/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { MAX_ANALYSIS_RESULT_BYTES } from "#typepeek/inspection/model/budget-policy";
import { enforceAnalysisRequestOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  InspectionOutcome,
  InspectionResult,
  InspectionResultIdentity,
} from "#typepeek/inspection/model/protocol";
import { readOwnOptionalProperty } from "#typepeek/inspection/model/untrusted-data";

export type {
  InspectionCacheHitNotice,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/cache/inspection-cache-codec";

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

    writeInspectionCacheFile(identity.key, () => JSON.stringify(payload));
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

/** Returns a structurally validated candidate; the worker must replay its proof before reuse. */
export const readInspectionCacheCandidate =
  function readInspectionCacheCandidate(
    identity: InspectionCacheIdentity
  ): ValidatedInspectionCachePayload | undefined {
    const payload = readAuthenticatedInspectionCacheFile(identity.key);

    if (payload === undefined) {
      return undefined;
    }

    try {
      return readCachePayload(payload, identity);
    } catch {
      return undefined;
    }
  };
