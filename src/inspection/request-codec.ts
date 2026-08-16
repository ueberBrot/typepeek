import {
  isBoundedExportSearchQuery,
  readInspectionPlanQueries,
} from "#typepeek/inspection/inspection-plan-query";
import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import type {
  AccessStyle,
  AnalysisRequest,
  AnalysisRequestReading,
  InspectionFailure,
  InspectionRequestReading,
  NormalizedExportInspectionRequest,
  NormalizedExportSearchRequest,
  NormalizedInterfaceOverviewRequest,
  NormalizedInspectionPlanRequest,
  NormalizedDeclarationInspectionRequest,
  NormalizedMemberInspectionRequest,
  NormalizedPublicSubpathDiscoveryRequest,
  NormalizedSignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
import { ANALYSIS_INTENTS } from "#typepeek/inspection/protocol-vocabulary";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const INVALID_ANALYSIS_REQUEST_OUTCOME: InspectionFailure = {
  status: "unsupported",
  reason: "invalid-request",
  message: "Inspection received an invalid request.",
};
const INVALID_REQUEST_OUTCOMES = {
  "interface-overview": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Interface Overview request.",
  },
  "export-inspection": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Export Inspection request.",
  },
  "signature-inspection": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Signature Inspection request.",
  },
  "inspection-plan": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Inspection Plan request.",
  },
  "export-search": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Export Search request.",
  },
  "public-subpath-discovery": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Public Subpath Discovery request.",
  },
  "declaration-inspection": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Declaration Inspection request.",
  },
  "member-inspection": {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Member Inspection request.",
  },
} as const satisfies Readonly<Record<AnalysisRequest["intent"], InspectionFailure>>;

const INSPECTION_REQUEST_FIELDS = [
  "resolutionContext",
  "specifier",
  "accessStyle",
  "queries",
  "query",
  "exportName",
  "memberPath",
] as const;
const ANALYSIS_REQUEST_FIELDS = ["intent", "request"] as const;

type AnalysisRequestReader = (value: unknown) => AnalysisRequest | undefined;

const ANALYSIS_INTENT_SET = new Set<AnalysisRequest["intent"]>(ANALYSIS_INTENTS);

/** Snapshots and validates one untrusted caller request without loading the outcome codec. */
export function readInspectionRequest(
  intent: "interface-overview",
  value: unknown,
): InspectionRequestReading<NormalizedInterfaceOverviewRequest>;
export function readInspectionRequest(
  intent: "export-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedExportInspectionRequest>;
export function readInspectionRequest(
  intent: "signature-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedSignatureInspectionRequest>;
export function readInspectionRequest(
  intent: "inspection-plan",
  value: unknown,
): InspectionRequestReading<NormalizedInspectionPlanRequest>;
export function readInspectionRequest(
  intent: "export-search",
  value: unknown,
): InspectionRequestReading<NormalizedExportSearchRequest>;
export function readInspectionRequest(
  intent: "public-subpath-discovery",
  value: unknown,
): InspectionRequestReading<NormalizedPublicSubpathDiscoveryRequest>;
export function readInspectionRequest(
  intent: "declaration-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedDeclarationInspectionRequest>;
export function readInspectionRequest(
  intent: "member-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedMemberInspectionRequest>;
export function readInspectionRequest(
  intent: AnalysisRequest["intent"],
  value: unknown,
): InspectionRequestReading<AnalysisRequest["request"]>;
export function readInspectionRequest(
  intent: AnalysisRequest["intent"],
  value: unknown,
): InspectionRequestReading<AnalysisRequest["request"]> {
  try {
    const candidate = snapshotDataProperties(value, INSPECTION_REQUEST_FIELDS);
    const target = candidate === undefined ? undefined : readInspectionTarget(candidate);
    if (target === undefined) {
      return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
    }
    if (intent === "interface-overview" || intent === "public-subpath-discovery") {
      return { accepted: true, request: target };
    }
    if (intent === "inspection-plan") {
      const reading = readInspectionPlanQueries(candidate?.["queries"]);
      return !reading.accepted
        ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
        : { accepted: true, request: { ...target, queries: reading.queries } };
    }
    if (intent === "export-search") {
      const query = candidate?.["query"];
      return isBoundedExportSearchQuery(query)
        ? { accepted: true, request: { ...target, query } }
        : { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
    }
    const exportName = candidate?.["exportName"];
    if (typeof exportName !== "string") {
      return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
    }
    if (intent !== "member-inspection") {
      return { accepted: true, request: { ...target, exportName } };
    }
    const memberPath = readBoundedMemberPath(candidate?.["memberPath"]);
    return memberPath === undefined
      ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
      : { accepted: true, request: { ...target, exportName, memberPath } };
  } catch {
    return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
  }
}

/** Revalidates the structured-cloned request at the isolated analysis-process seam. */
export function readAnalysisRequest(value: unknown): AnalysisRequestReading {
  try {
    const envelope = snapshotDataProperties(value, ANALYSIS_REQUEST_FIELDS);
    const intent = envelope?.["intent"];
    if (!isInspectionIntent(intent)) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }
    const reading = readRequestForIntent(intent, envelope?.["request"]);
    return reading === undefined
      ? { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME }
      : { accepted: true, request: reading };
  } catch {
    return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
}

function readRequestForIntent(
  intent: AnalysisRequest["intent"],
  value: unknown,
): AnalysisRequest | undefined {
  return ANALYSIS_REQUEST_READERS[intent](value);
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

function readInspectionTarget(
  value: Readonly<Record<string, unknown>>,
): NormalizedInterfaceOverviewRequest | undefined {
  const resolutionContext = value["resolutionContext"];
  const specifier = value["specifier"];
  const accessStyle = value["accessStyle"];
  if (
    typeof resolutionContext !== "string" ||
    typeof specifier !== "string" ||
    !isAccessStyle(accessStyle)
  ) {
    return undefined;
  }
  return { resolutionContext, specifier, accessStyle: accessStyle ?? "import" };
}

function isAccessStyle(value: unknown): value is AccessStyle | undefined {
  return value === undefined || value === "import" || value === "require";
}

function isInspectionIntent(value: unknown): value is AnalysisRequest["intent"] {
  return typeof value === "string" && ANALYSIS_INTENT_SET.has(value as AnalysisRequest["intent"]);
}
