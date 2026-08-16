import {
  inspectExport,
  inspectExportDeclarations,
  inspectExportMember,
  inspectExportSearch,
  inspectExportSignatures,
  inspectInterfaceOverview,
  inspectPlan,
  inspectPublicSubpaths,
} from "#typepeek/inspection/core";
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
  SignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
import {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import { readInspectionRequest } from "#typepeek/inspection/request-codec";

export interface InspectionRequestByIntent {
  readonly "interface-overview": InterfaceOverviewRequest;
  readonly "export-inspection": ExportInspectionRequest;
  readonly "signature-inspection": SignatureInspectionRequest;
  readonly "export-search": ExportSearchRequest;
  readonly "public-subpath-discovery": PublicSubpathDiscoveryRequest;
  readonly "declaration-inspection": DeclarationInspectionRequest;
  readonly "member-inspection": MemberInspectionRequest;
  readonly "inspection-plan": InspectionPlanRequest;
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
  return protocolResponse(await dispatchInspection(envelope.intent, envelope.request));
}

async function dispatchInspection(
  intent: InspectionIntent,
  request: unknown,
): Promise<InspectionOutcome> {
  return INSPECTION_DISPATCHERS[intent](request);
}

type InspectionDispatcher = (request: unknown) => Promise<InspectionOutcome>;

const INSPECTION_DISPATCHERS = {
  "interface-overview": dispatchInterfaceOverview,
  "export-inspection": dispatchExportInspection,
  "signature-inspection": dispatchSignatureInspection,
  "export-search": dispatchExportSearch,
  "public-subpath-discovery": dispatchPublicSubpathDiscovery,
  "declaration-inspection": dispatchDeclarationInspection,
  "member-inspection": dispatchMemberInspection,
  "inspection-plan": dispatchInspectionPlan,
} as const satisfies Readonly<Record<InspectionIntent, InspectionDispatcher>>;

async function dispatchInterfaceOverview(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("interface-overview", request);
  return reading.accepted ? inspectInterfaceOverview(reading.request) : reading.outcome;
}

async function dispatchExportInspection(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("export-inspection", request);
  return reading.accepted ? inspectExport(reading.request) : reading.outcome;
}

async function dispatchSignatureInspection(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("signature-inspection", request);
  return reading.accepted ? inspectExportSignatures(reading.request) : reading.outcome;
}

async function dispatchExportSearch(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("export-search", request);
  return reading.accepted ? inspectExportSearch(reading.request) : reading.outcome;
}

async function dispatchPublicSubpathDiscovery(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("public-subpath-discovery", request);
  return reading.accepted ? inspectPublicSubpaths(reading.request) : reading.outcome;
}

async function dispatchDeclarationInspection(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("declaration-inspection", request);
  return reading.accepted ? inspectExportDeclarations(reading.request) : reading.outcome;
}

async function dispatchMemberInspection(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("member-inspection", request);
  return reading.accepted ? inspectExportMember(reading.request) : reading.outcome;
}

async function dispatchInspectionPlan(request: unknown): Promise<InspectionOutcome> {
  const reading = readInspectionRequest("inspection-plan", request);
  return reading.accepted ? inspectPlan(reading.request) : reading.outcome;
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
  const record = plainRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const version = dataProperty(record, "protocolVersion");
  const intent = dataProperty(record, "intent");
  const request = dataProperty(record, "request");
  if (!isBoundedProtocolVersion(version)) {
    return undefined;
  }
  return { protocolVersion: version, intent, request };
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function isBoundedProtocolVersion(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= 64;
}

function dataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isInspectionIntent(value: unknown): value is InspectionIntent {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 64 &&
    (INSPECTION_INTENTS as readonly string[]).includes(value)
  );
}
