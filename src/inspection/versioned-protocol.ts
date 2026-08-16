import { invokeInspectionCore } from "#typepeek/inspection/core";
import type {
  InspectionPlanRequest,
  InspectionFailure,
  InspectionOutcome,
  DeclarationInspectionRequest,
  ExportInspectionRequest,
  ExportSearchRequest,
  InterfaceOverviewRequest,
  MemberInspectionRequest,
  PublicSubpathDiscoveryRequest,
  PublicInterfaceComparisonRequest,
  SignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
import {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const PROTOCOL_ENVELOPE_FIELDS = ["protocolVersion", "intent", "request"] as const;

export interface InspectionRequestByIntent {
  readonly "interface-overview": InterfaceOverviewRequest;
  readonly "export-inspection": ExportInspectionRequest;
  readonly "signature-inspection": SignatureInspectionRequest;
  readonly "export-search": ExportSearchRequest;
  readonly "public-subpath-discovery": PublicSubpathDiscoveryRequest;
  readonly "declaration-inspection": DeclarationInspectionRequest;
  readonly "member-inspection": MemberInspectionRequest;
  readonly "inspection-plan": InspectionPlanRequest;
  readonly "public-interface-comparison": PublicInterfaceComparisonRequest;
}

export type InspectionProtocolRequest = {
  readonly [Intent in InspectionIntent]: {
    readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
    readonly intent: Intent;
    readonly request: InspectionRequestByIntent[Intent];
  };
}[InspectionIntent];

export interface InspectionProtocolResponse {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: InspectionOutcome;
}

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
  return protocolResponse(await invokeInspectionCore(envelope.intent, envelope.request));
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
  };
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
