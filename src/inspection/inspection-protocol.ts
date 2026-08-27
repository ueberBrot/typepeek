import { Effect, Predicate, Result, Schema } from "effect";

import { invokeInspectionCore } from "#typepeek/inspection/core";
import {
  inspectionProtocolRequestSchema,
  inspectionProtocolResponseSchema,
  supportsSignatureEvidence,
  type InspectionProtocolResponse,
  type NormalizedInspectionProtocolRequest,
  type SignatureEvidenceKind,
} from "#typepeek/inspection/inspection-protocol-schema";
import type { InspectionFailure, InspectionOutcome } from "#typepeek/inspection/protocol";
import { protocolRecoveryGuidance } from "#typepeek/inspection/protocol-recovery";
import {
  inspectionIntentSchema,
  inspectionProtocolResponseOptionsSchema,
  INSPECTION_PROTOCOL_VERSION,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import { readInspectionRequest } from "#typepeek/inspection/request-definitions";
import {
  projectInspectionOutcome,
  signatureEvidenceProjection,
} from "#typepeek/inspection/signature-evidence-projection";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const PROTOCOL_HEADER_FIELDS = ["protocolVersion", "intent", "request", "response"] as const;
const definedResponseSchema = Schema.Unknown.check(
  Schema.makeFilter(Predicate.isNotUndefined, { expected: "a defined response" }),
);
const protocolHeaderSchema = Schema.Struct({
  protocolVersion: Schema.String.check(
    Schema.makeFilter((version) => Buffer.byteLength(version) <= 64, {
      expected: "a bounded protocol version",
    }),
  ),
  intent: inspectionIntentSchema,
  request: Schema.Unknown,
  response: Schema.optionalKey(definedResponseSchema),
});
const decodeProtocolHeader = Schema.decodeUnknownResult(protocolHeaderSchema);
const decodeInspectionProtocolRequest = Schema.decodeUnknownResult(inspectionProtocolRequestSchema);
const decodeInspectionProtocolResponse = Schema.decodeUnknownResult(
  inspectionProtocolResponseSchema,
);
const decodeProtocolResponseOptions = Schema.decodeUnknownResult(
  inspectionProtocolResponseOptionsSchema,
);
type ProtocolHeader = typeof protocolHeaderSchema.Type;
const INVALID_PROTOCOL_RESULT_RESPONSE = Schema.decodeSync(inspectionProtocolResponseSchema)({
  protocolVersion: INSPECTION_PROTOCOL_VERSION,
  outcome: {
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection produced an invalid protocol result.",
  },
});

/** Validates and dispatches one Inspection Protocol request through the Inspection Core. */
export async function invokeInspectionProtocol(
  value: unknown,
): Promise<InspectionProtocolResponse> {
  let header: ProtocolHeader | undefined;
  try {
    header = readProtocolHeader(value);
  } catch {
    return protocolResponse(invalidProtocolRequest());
  }
  if (header === undefined) {
    return protocolResponse(invalidProtocolRequest());
  }
  if (header.protocolVersion !== INSPECTION_PROTOCOL_VERSION) {
    return protocolResponse({
      status: "unsupported",
      reason: "unsupported-protocol-version",
      message: `Inspection protocol version "${header.protocolVersion}" is not supported.`,
    });
  }
  const request = readProtocolRequest(header);
  if (request === undefined) {
    return protocolResponse(invalidProtocolRequest());
  }
  const projection = readSignatureEvidenceProjection(request);
  const invocation = await Effect.runPromise(invokeInspectionCore(request.intent, request.request));
  const candidate =
    projection === undefined
      ? { protocolVersion: INSPECTION_PROTOCOL_VERSION, outcome: invocation.outcome }
      : {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          projection: signatureEvidenceProjection(projection),
          outcome: projectInspectionOutcome(invocation.outcome, projection),
        };
  if (invocation.preparedRequest === undefined) {
    return protocolResponseFrom(candidate);
  }
  const recovery = protocolRecoveryGuidance(invocation.preparedRequest, invocation.outcome);
  return protocolResponseFrom(recovery.length === 0 ? candidate : { ...candidate, recovery });
}

function protocolResponse(outcome: InspectionOutcome): InspectionProtocolResponse {
  return protocolResponseFrom({ protocolVersion: INSPECTION_PROTOCOL_VERSION, outcome });
}

function protocolResponseFrom(value: unknown): InspectionProtocolResponse {
  return (
    Result.getOrUndefined(decodeInspectionProtocolResponse(value)) ??
    INVALID_PROTOCOL_RESULT_RESPONSE
  );
}

function invalidProtocolRequest(): InspectionFailure {
  return {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid protocol request.",
  };
}

function readProtocolHeader(value: unknown): ProtocolHeader | undefined {
  const record = snapshotDataProperties(value, PROTOCOL_HEADER_FIELDS);
  return record === undefined ? undefined : Result.getOrUndefined(decodeProtocolHeader(record));
}

function readProtocolRequest(
  header: ProtocolHeader,
): NormalizedInspectionProtocolRequest | undefined {
  const reading = readInspectionRequest(header.intent, header.request);
  if (!reading.accepted) {
    return undefined;
  }
  const response = readProtocolResponseOptions(header.intent, header.response);
  if (response === null) {
    return undefined;
  }
  const candidate = {
    protocolVersion: header.protocolVersion,
    intent: header.intent,
    request: reading.request,
    ...(response === undefined ? {} : { response }),
  };
  return Result.getOrUndefined(decodeInspectionProtocolRequest(candidate));
}

function readProtocolResponseOptions(
  intent: InspectionIntent,
  response: unknown,
): { readonly signatureEvidence: SignatureEvidenceKind } | null | undefined {
  if (!supportsSignatureEvidence(intent)) {
    return response === undefined ? undefined : null;
  }
  if (response === undefined) {
    return undefined;
  }
  const snapshot = snapshotDataProperties(response, ["signatureEvidence"] as const);
  return snapshot === undefined
    ? null
    : (Result.getOrUndefined(decodeProtocolResponseOptions(snapshot)) ?? null);
}

function readSignatureEvidenceProjection(
  request: NormalizedInspectionProtocolRequest,
): SignatureEvidenceKind | undefined {
  return supportsSignatureEvidence(request.intent)
    ? (request.response?.signatureEvidence ?? "structured")
    : undefined;
}
