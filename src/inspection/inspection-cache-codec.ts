import ts from "@typescript/typescript6";
import { Result, Schema } from "effect";
import { isAbsolute } from "node:path";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import { installedEvidenceProofSchema } from "#typepeek/inspection/installed-evidence-fingerprint";
import {
  packageInspectionResultIdentitySchema,
  platformInspectionResultIdentitySchema,
} from "#typepeek/inspection/protocol";
import { analysisRequestSchema } from "#typepeek/inspection/request-definitions";
import { snapshotBoundedDataPropertyGraph } from "#typepeek/inspection/untrusted-data";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";

export const CACHE_SCHEMA_VERSION = 1;
export const INSPECTION_CACHE_SEMANTICS_VERSION = "2";
export const MAX_CACHE_ENTRY_BYTES = 160 * 1_024;
const MAX_CACHE_RECEIPT_BYTES = 96 * 1_024;
const MAX_CACHE_PATH_BYTES = 4 * 1_024;

const MAX_CACHE_IPC_GRAPH_OBJECTS = 4_096;
const MAX_CACHE_IPC_GRAPH_VALUES = 32_768;
const MAX_CACHE_HIT_NOTICE_BYTES = 1_024;
const SHA256_PATTERN = /^[\da-f]{64}$/u;
const STRICT_CACHE_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const boundedStringSchema = Schema.String.check(
  Schema.makeFilter((value) => Buffer.byteLength(value) <= MAX_CACHE_PATH_BYTES, {
    expected: `a string no larger than ${MAX_CACHE_PATH_BYTES} UTF-8 bytes`,
  }),
);
const boundedAbsolutePathSchema = boundedStringSchema.check(
  Schema.makeFilter(isAbsolute, { expected: "a bounded absolute path" }),
);
const sha256Schema = Schema.String.check(
  Schema.makeFilter((value) => SHA256_PATTERN.test(value), {
    expected: "a lowercase SHA-256 digest",
  }),
);
const cacheEvidenceFields = {
  declarationPath: boundedAbsolutePathSchema,
  declarationRoot: boundedAbsolutePathSchema,
  repositoryRoot: boundedAbsolutePathSchema,
  resolutionContextDirectory: boundedAbsolutePathSchema,
} as const;
const boundedPackageResultIdentitySchema = packageInspectionResultIdentitySchema.check(
  Schema.makeFilter(hasOnlyBoundedStrings, { expected: "bounded Package Identity strings" }),
);
const boundedPlatformResultIdentitySchema = platformInspectionResultIdentitySchema.check(
  Schema.makeFilter(hasOnlyBoundedStrings, { expected: "bounded Package Identity strings" }),
);
const cacheEvidenceIdentitySchema = Schema.Union([
  Schema.Struct({
    ...cacheEvidenceFields,
    kind: Schema.Literal("package"),
    resultIdentity: boundedPackageResultIdentitySchema,
  }),
  Schema.Struct({
    ...cacheEvidenceFields,
    kind: Schema.Literal("platform"),
    resultIdentity: boundedPlatformResultIdentitySchema,
  }),
]);
const boundedAnalysisRequestSchema = analysisRequestSchema.check(
  Schema.makeFilter(hasOnlyBoundedStrings, { expected: "bounded Analysis Request strings" }),
);
const inspectionCacheIdentityValueSchema = Schema.Struct({
  budgetPolicy: Schema.Literal(INSPECTION_BUDGET_POLICY.identity),
  cacheSemanticsVersion: Schema.Literal(INSPECTION_CACHE_SEMANTICS_VERSION),
  compilerVersion: Schema.Literal(ts.version),
  evidence: cacheEvidenceIdentitySchema,
  request: boundedAnalysisRequestSchema,
  typepeekVersion: Schema.Literal(TYPEPEEK_VERSION),
});
const inspectionCacheWriteReceiptSchema = Schema.Struct({
  identity: inspectionCacheIdentityValueSchema,
  kind: Schema.Literal("inspection-cache-write"),
  proof: installedEvidenceProofSchema,
});
const inspectionCacheHitNoticeSchema = Schema.Struct({
  key: sha256Schema,
  kind: Schema.Literal("inspection-cache-hit"),
});
const inspectionCachePayloadSchema = Schema.Struct({
  identity: inspectionCacheIdentityValueSchema,
  outcome: Schema.Unknown,
  proof: installedEvidenceProofSchema,
});
const inspectionCacheEnvelopeSchema = Schema.Struct({
  integrity: sha256Schema,
  payload: Schema.String.check(
    Schema.makeFilter((value) => Buffer.byteLength(value) <= MAX_CACHE_ENTRY_BYTES, {
      expected: `a payload no larger than ${MAX_CACHE_ENTRY_BYTES} UTF-8 bytes`,
    }),
  ),
  schemaVersion: Schema.Literal(CACHE_SCHEMA_VERSION),
});

export type InspectionCacheIdentityValue = typeof inspectionCacheIdentityValueSchema.Type;
export type EncodedInspectionCacheIdentityValue = typeof inspectionCacheIdentityValueSchema.Encoded;
export type InspectionCacheWriteReceipt = typeof inspectionCacheWriteReceiptSchema.Type;
export type InspectionCacheHitNotice = typeof inspectionCacheHitNoticeSchema.Type;
export type InspectionCachePayload = typeof inspectionCachePayloadSchema.Type;
export type InspectionCacheEnvelope = typeof inspectionCacheEnvelopeSchema.Type;

const decodeCacheWriteReceipt = Schema.decodeUnknownResult(
  inspectionCacheWriteReceiptSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const decodeCacheIdentityValue = Schema.decodeUnknownResult(
  inspectionCacheIdentityValueSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const decodeCacheKey = Schema.decodeUnknownResult(sha256Schema);
const decodeCachePath = Schema.decodeUnknownResult(boundedAbsolutePathSchema);
const encodeCacheIdentityValue = Schema.encodeUnknownResult(
  inspectionCacheIdentityValueSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const encodeCacheWriteReceipt = Schema.encodeUnknownResult(
  inspectionCacheWriteReceiptSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const decodeCacheHitNotice = Schema.decodeUnknownResult(
  inspectionCacheHitNoticeSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const encodeCacheHitNotice = Schema.encodeUnknownResult(
  inspectionCacheHitNoticeSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const decodeCachePayload = Schema.decodeUnknownResult(
  inspectionCachePayloadSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const encodeCachePayload = Schema.encodeUnknownResult(
  inspectionCachePayloadSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const decodeCacheEnvelope = Schema.decodeUnknownResult(
  inspectionCacheEnvelopeSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);
const encodeCacheEnvelope = Schema.encodeUnknownResult(
  inspectionCacheEnvelopeSchema,
  STRICT_CACHE_PARSE_OPTIONS,
);

export function readInspectionCacheWriteReceiptMessage(
  value: unknown,
): InspectionCacheWriteReceipt | undefined {
  const snapshot = snapshotCacheIpcValue(value, MAX_CACHE_RECEIPT_BYTES);
  return snapshot === undefined
    ? undefined
    : Result.getOrUndefined(decodeCacheWriteReceipt(snapshot));
}

export function readInspectionCacheKey(value: unknown): string | undefined {
  return Result.getOrUndefined(decodeCacheKey(value));
}

export function readInspectionCachePath(value: unknown): string | undefined {
  return Result.getOrUndefined(decodeCachePath(value));
}

export function encodeInspectionCacheIdentityValue(
  value: unknown,
): EncodedInspectionCacheIdentityValue | undefined {
  return decodeThenEncode(value, decodeCacheIdentityValue, encodeCacheIdentityValue);
}

export function encodeInspectionCacheWriteReceipt(
  value: unknown,
): typeof inspectionCacheWriteReceiptSchema.Encoded | undefined {
  return decodeThenEncode(value, decodeCacheWriteReceipt, encodeCacheWriteReceipt);
}

export function readInspectionCacheHitNoticeMessage(
  value: unknown,
): InspectionCacheHitNotice | undefined {
  const snapshot = snapshotCacheIpcValue(value, MAX_CACHE_HIT_NOTICE_BYTES);
  return snapshot === undefined ? undefined : Result.getOrUndefined(decodeCacheHitNotice(snapshot));
}

export function encodeInspectionCacheHitNotice(
  value: unknown,
): InspectionCacheHitNotice | undefined {
  return decodeThenEncode(value, decodeCacheHitNotice, encodeCacheHitNotice);
}

export function readInspectionCachePayload(value: unknown): InspectionCachePayload | undefined {
  return Result.getOrUndefined(decodeCachePayload(value));
}

export function encodeInspectionCachePayload(
  value: unknown,
): typeof inspectionCachePayloadSchema.Encoded | undefined {
  return decodeThenEncode(value, decodeCachePayload, encodeCachePayload);
}

export function readInspectionCacheEnvelope(value: unknown): InspectionCacheEnvelope | undefined {
  return Result.getOrUndefined(decodeCacheEnvelope(value));
}

export function encodeInspectionCacheEnvelope(value: unknown): InspectionCacheEnvelope | undefined {
  return decodeThenEncode(value, decodeCacheEnvelope, encodeCacheEnvelope);
}

function decodeThenEncode<Decoded, Encoded>(
  value: unknown,
  decode: (value: unknown) => Result.Result<Decoded, unknown>,
  encode: (value: Decoded) => Result.Result<Encoded, unknown>,
): Encoded | undefined {
  const decoded = Result.getOrUndefined(decode(value));
  return decoded === undefined ? undefined : Result.getOrUndefined(encode(decoded));
}

function snapshotCacheIpcValue(value: unknown, maximumSerializedBytes: number): unknown {
  return snapshotBoundedDataPropertyGraph(value, {
    maximumObjects: MAX_CACHE_IPC_GRAPH_OBJECTS,
    maximumSerializedBytes,
    maximumStringBytes: MAX_CACHE_PATH_BYTES,
    maximumValues: MAX_CACHE_IPC_GRAPH_VALUES,
  });
}

function hasOnlyBoundedStrings(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (Buffer.byteLength(current) > MAX_CACHE_PATH_BYTES) {
        return false;
      }
      continue;
    }
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return true;
}
