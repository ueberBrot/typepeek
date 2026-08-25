import { invokeInspectionCoreWithReceipt } from "#typepeek/inspection/core";
import type {
  InspectionFailure,
  InspectionOutcome,
  InspectionProtocolResponse,
  SignatureEvidenceKind,
} from "#typepeek/inspection/protocol";
import { protocolRecoveryGuidance } from "#typepeek/inspection/protocol-recovery";
import {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  isSignatureEvidenceKind,
  projectInspectionOutcome,
  signatureEvidenceProjection,
} from "#typepeek/inspection/signature-evidence-projection";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const PROTOCOL_ENVELOPE_FIELDS = ["protocolVersion", "intent", "request", "response"] as const;
const PROTOCOL_RESPONSE_OPTION_FIELDS = ["signatureEvidence"] as const;

/** Validates and dispatches one versioned request through the Inspection Core. */
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
  if (!isInspectionIntent(envelope.intent)) {
    return protocolResponse(invalidProtocolRequest());
  }
  const projection = readSignatureEvidenceProjection(envelope.intent, envelope.response);
  if (projection === null) {
    return protocolResponse(invalidProtocolRequest());
  }
  const invocation = await invokeInspectionCoreWithReceipt(envelope.intent, envelope.request);
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
    message: "Inspection received an invalid versioned protocol request.",
  };
}

interface ProtocolEnvelope {
  readonly protocolVersion: string;
  readonly intent: unknown;
  readonly request: unknown;
  readonly response: unknown;
}

function readProtocolEnvelope(value: unknown): ProtocolEnvelope | undefined {
  const record = snapshotDataProperties(value, PROTOCOL_ENVELOPE_FIELDS);
  if (record === undefined) {
    return undefined;
  }
  const version = record["protocolVersion"];
  if (!isBoundedProtocolVersion(version)) {
    return undefined;
  }
  return {
    protocolVersion: version,
    intent: record["intent"],
    request: record["request"],
    response: record["response"],
  };
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
  const signatureEvidence = options?.["signatureEvidence"];
  return isSignatureEvidenceKind(signatureEvidence) ? signatureEvidence : null;
}

function isBoundedProtocolVersion(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= 64;
}

function isInspectionIntent(value: unknown): value is InspectionIntent {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 64 &&
    (INSPECTION_INTENTS as readonly string[]).includes(value)
  );
}
