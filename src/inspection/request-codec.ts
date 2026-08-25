import type {
  AnalysisRequest,
  AnalysisRequestReading,
  InspectionFailure,
  InspectionRequestReading,
} from "#typepeek/inspection/protocol";
import { ANALYSIS_INTENTS, type InspectionIntent } from "#typepeek/inspection/protocol-vocabulary";
import {
  type NormalizedInspectionRequestByIntent,
  readDefinedInspectionRequest,
} from "#typepeek/inspection/request-definitions";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const INVALID_ANALYSIS_REQUEST_OUTCOME: InspectionFailure = {
  status: "unsupported",
  reason: "invalid-request",
  message: "Inspection received an invalid request.",
};
const INVALID_REQUEST_OUTCOMES = {
  "interface-overview": invalidRequest("Interface Overview"),
  "export-inspection": invalidRequest("Export Inspection"),
  "signature-inspection": invalidRequest("Signature Inspection"),
  "inspection-plan": invalidRequest("Inspection Plan"),
  "export-search": invalidRequest("Export Search"),
  "public-subpath-discovery": invalidRequest("Public Subpath Discovery"),
  "declaration-inspection": invalidRequest("Declaration Inspection"),
  "member-inspection": invalidRequest("Member Inspection"),
  "public-interface-comparison": invalidRequest("Public Interface Comparison"),
} as const satisfies Readonly<Record<InspectionIntent, InspectionFailure>>;

const ANALYSIS_REQUEST_FIELDS = ["intent", "request"] as const;
const ANALYSIS_INTENT_SET = new Set<AnalysisRequest["intent"]>(ANALYSIS_INTENTS);

type AnalysisRequestReader = (value: unknown) => AnalysisRequest | undefined;

/** Validates one untrusted caller request through its published executable definition. */
export function readInspectionRequest<Intent extends InspectionIntent>(
  intent: Intent,
  value: unknown,
): InspectionRequestReading<NormalizedInspectionRequestByIntent[Intent]> {
  const request = readDefinedInspectionRequest(intent, value);
  return request === undefined
    ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
    : { accepted: true, request };
}

/** Revalidates the structured-cloned request at the isolated analysis-process seam. */
export function readAnalysisRequest(value: unknown): AnalysisRequestReading {
  try {
    const envelope = snapshotDataProperties(value, ANALYSIS_REQUEST_FIELDS);
    const intent = envelope?.["intent"];
    if (!isInspectionIntent(intent)) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }
    const reading = ANALYSIS_REQUEST_READERS[intent](envelope?.["request"]);
    return reading === undefined
      ? { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME }
      : { accepted: true, request: reading };
  } catch {
    return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
}

const ANALYSIS_REQUEST_READERS = {
  "interface-overview": analysisRequestReader("interface-overview"),
  "export-inspection": analysisRequestReader("export-inspection"),
  "signature-inspection": analysisRequestReader("signature-inspection"),
  "inspection-plan": analysisRequestReader("inspection-plan"),
  "export-search": analysisRequestReader("export-search"),
  "public-subpath-discovery": analysisRequestReader("public-subpath-discovery"),
  "declaration-inspection": analysisRequestReader("declaration-inspection"),
  "member-inspection": analysisRequestReader("member-inspection"),
} as const satisfies Readonly<Record<AnalysisRequest["intent"], AnalysisRequestReader>>;

function analysisRequestReader(intent: AnalysisRequest["intent"]): AnalysisRequestReader {
  return (value) => {
    const reading = readInspectionRequest(intent, value);
    return reading.accepted ? ({ intent, request: reading.request } as AnalysisRequest) : undefined;
  };
}

function invalidRequest(name: string): InspectionFailure {
  return {
    status: "unsupported",
    reason: "invalid-request",
    message: `Inspection received an invalid ${name} request.`,
  };
}

function isInspectionIntent(value: unknown): value is AnalysisRequest["intent"] {
  return typeof value === "string" && ANALYSIS_INTENT_SET.has(value as AnalysisRequest["intent"]);
}
