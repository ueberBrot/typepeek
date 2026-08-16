import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import type {
  AccessStyle,
  AnalysisRequest,
  AnalysisRequestReading,
  InspectionFailure,
  InspectionPlanQuery,
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

const MAX_INSPECTION_PLAN_QUERIES = 16;
const MAX_EXPORT_SEARCH_QUERY_BYTES = 256;
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
const INSPECTION_PLAN_QUERY_FIELDS = ["intent", "query", "exportName", "memberPath"] as const;

type AnalysisRequestReader = (value: unknown) => AnalysisRequest | undefined;
type InspectionPlanQueryReader = (
  value: Readonly<Record<string, unknown>>,
) => InspectionPlanQuery | undefined;

const ANALYSIS_INTENT_SET = new Set<AnalysisRequest["intent"]>(ANALYSIS_INTENTS);
const INSPECTION_PLAN_QUERY_INTENTS = new Set<InspectionPlanQuery["intent"]>([
  "interface-overview",
  "export-inspection",
  "signature-inspection",
  "export-search",
  "public-subpath-discovery",
  "declaration-inspection",
  "member-inspection",
]);

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
    const candidate = snapshotRecord(value, INSPECTION_REQUEST_FIELDS);
    const target = candidate === undefined ? undefined : readInspectionTarget(candidate);
    if (target === undefined) {
      return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
    }
    if (intent === "interface-overview" || intent === "public-subpath-discovery") {
      return { accepted: true, request: target };
    }
    if (intent === "inspection-plan") {
      const queries = readInspectionPlanQueries(candidate?.["queries"]);
      return queries === undefined
        ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
        : { accepted: true, request: { ...target, queries } };
    }
    if (intent === "export-search") {
      const query = candidate?.["query"];
      return isExportSearchQuery(query)
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
    const envelope = snapshotRecord(value, ANALYSIS_REQUEST_FIELDS);
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

function readInspectionPlanQueries(value: unknown): readonly InspectionPlanQuery[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INSPECTION_PLAN_QUERIES) {
    return undefined;
  }
  const queries: InspectionPlanQuery[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      return undefined;
    }
    const query = readInspectionPlanQuery(descriptor.value);
    if (query === undefined) {
      return undefined;
    }
    queries.push(query);
  }
  return queries;
}

function readInspectionPlanQuery(value: unknown): InspectionPlanQuery | undefined {
  const query = snapshotRecord(value, INSPECTION_PLAN_QUERY_FIELDS);
  const intent = query?.["intent"];
  return query !== undefined && isInspectionPlanQueryIntent(intent)
    ? INSPECTION_PLAN_QUERY_READERS[intent](query)
    : undefined;
}

const INSPECTION_PLAN_QUERY_READERS = {
  "interface-overview": () => ({ intent: "interface-overview" }),
  "public-subpath-discovery": () => ({ intent: "public-subpath-discovery" }),
  "export-search": (value) => {
    const query = value["query"];
    return isExportSearchQuery(query) ? { intent: "export-search", query } : undefined;
  },
  "export-inspection": (value) => readFocusedPlanQuery("export-inspection", value),
  "signature-inspection": (value) => readFocusedPlanQuery("signature-inspection", value),
  "declaration-inspection": (value) => readFocusedPlanQuery("declaration-inspection", value),
  "member-inspection": (value) => readMemberPlanQuery(value),
} as const satisfies Readonly<Record<InspectionPlanQuery["intent"], InspectionPlanQueryReader>>;

function readFocusedPlanQuery(
  intent: "export-inspection" | "signature-inspection" | "declaration-inspection",
  value: Readonly<Record<string, unknown>>,
): InspectionPlanQuery | undefined {
  const exportName = value["exportName"];
  return typeof exportName === "string" ? { intent, exportName } : undefined;
}

function readMemberPlanQuery(
  value: Readonly<Record<string, unknown>>,
): InspectionPlanQuery | undefined {
  const exportName = value["exportName"];
  const memberPath = readBoundedMemberPath(value["memberPath"]);
  return typeof exportName === "string" && memberPath !== undefined
    ? { intent: "member-inspection", exportName, memberPath }
    : undefined;
}

function isInspectionPlanQueryIntent(value: unknown): value is InspectionPlanQuery["intent"] {
  return (
    typeof value === "string" &&
    INSPECTION_PLAN_QUERY_INTENTS.has(value as InspectionPlanQuery["intent"])
  );
}

function isExportSearchQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_EXPORT_SEARCH_QUERY_BYTES
  );
}

function snapshotRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
