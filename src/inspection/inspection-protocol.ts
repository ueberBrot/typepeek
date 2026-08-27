import { Effect, Predicate, Result, Schema } from "effect";

import { invokeInspectionCore } from "#typepeek/inspection/core";
import type {
  InspectionProtocolResponse,
  SignatureEvidenceKind,
} from "#typepeek/inspection/inspection-protocol-types";
import type { InspectionFailure, InspectionOutcome } from "#typepeek/inspection/protocol";
import { protocolRecoveryGuidance } from "#typepeek/inspection/protocol-recovery";
import {
  inspectionIntentSchema,
  inspectionProtocolResponseOptionsSchema,
  INSPECTION_PROTOCOL_VERSION,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  projectInspectionOutcome,
  signatureEvidenceProjection,
} from "#typepeek/inspection/signature-evidence-projection";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const PROTOCOL_ENVELOPE_FIELDS = ["protocolVersion", "intent", "request", "response"] as const;
const PROTOCOL_RESPONSE_OPTION_FIELDS = ["signatureEvidence"] as const;
const definedResponseSchema = Schema.Unknown.check(
  Schema.makeFilter(Predicate.isNotUndefined, { expected: "a defined response" }),
);
const protocolEnvelopeSchema = Schema.Struct({
  protocolVersion: Schema.String.check(
    Schema.makeFilter((version) => Buffer.byteLength(version) <= 64, {
      expected: "a bounded protocol version",
    }),
  ),
  intent: inspectionIntentSchema,
  request: Schema.Unknown,
  response: Schema.optionalKey(definedResponseSchema),
});
const decodeProtocolEnvelope = Schema.decodeUnknownResult(protocolEnvelopeSchema);
const decodeSignatureEvidenceOptions = Schema.decodeUnknownResult(
  inspectionProtocolResponseOptionsSchema,
);
type ProtocolEnvelope = typeof protocolEnvelopeSchema.Type;

/** Validates and dispatches one Inspection Protocol request through the Inspection Core. */
export async function invokeInspectionProtocol(
  value: unknown,
): Promise<InspectionProtocolResponse> {
  let envelope: ProtocolEnvelope | undefined;
  try {
    envelope = readProtocolEnvelope(value);
  } catch {
    return protocolResponse(invalidProtocolRequest());
  }
  if (envelope === undefined) {
    return protocolResponse(invalidProtocolRequest());
  }
  if (envelope.protocolVersion !== INSPECTION_PROTOCOL_VERSION) {
    return protocolResponse({
      status: "unsupported",
      reason: "unsupported-protocol-version",
      message: `Inspection protocol version "${envelope.protocolVersion}" is not supported.`,
    });
  }
  const projection = readSignatureEvidenceProjection(envelope.intent, envelope.response);
  if (projection === null) {
    return protocolResponse(invalidProtocolRequest());
  }
  const invocation = await Effect.runPromise(
    invokeInspectionCore(envelope.intent, envelope.request),
  );
  const response =
    projection === undefined
      ? protocolResponse(invocation.outcome)
      : {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          projection: signatureEvidenceProjection(projection),
          outcome: projectInspectionOutcome(invocation.outcome, projection),
        };
  if (invocation.preparedRequest === undefined) {
    return response;
  }
  const recovery = protocolRecoveryGuidance(invocation.preparedRequest, invocation.outcome);
  return recovery.length === 0 ? response : { ...response, recovery };
}

function protocolResponse(outcome: InspectionOutcome): InspectionProtocolResponse {
  return { protocolVersion: INSPECTION_PROTOCOL_VERSION, outcome };
}

function invalidProtocolRequest(): InspectionFailure {
  return {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid protocol request.",
  };
}

function readProtocolEnvelope(value: unknown): ProtocolEnvelope | undefined {
  const record = snapshotDataProperties(value, PROTOCOL_ENVELOPE_FIELDS);
  return record === undefined ? undefined : Result.getOrUndefined(decodeProtocolEnvelope(record));
}

function readSignatureEvidenceProjection(
  intent: InspectionIntent,
  response: unknown,
): SignatureEvidenceKind | null | undefined {
  const supportsProjection = intent === "signature-inspection" || intent === "inspection-plan";
  if (!supportsProjection) {
    return response === undefined ? undefined : null;
  }
  if (response === undefined) {
    return "structured";
  }
  const options = snapshotDataProperties(response, PROTOCOL_RESPONSE_OPTION_FIELDS);
  if (options === undefined) {
    return null;
  }
  return Result.getOrUndefined(decodeSignatureEvidenceOptions(options))?.signatureEvidence ?? null;
}
