import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import type { AnalysisRequest, InspectionPlanQuery } from "#typepeek/inspection/protocol";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const MAX_INSPECTION_PLAN_QUERIES = 16;
const MAX_EXPORT_SEARCH_QUERY_BYTES = 256;
const INSPECTION_PLAN_QUERY_FIELDS = ["intent", "query", "exportName", "memberPath"] as const;

export type InspectionPlanQueryIssue =
  | "invalid-list"
  | "invalid-entry"
  | "unsupported-intent"
  | "invalid-search"
  | "invalid-focused"
  | "invalid-member";

export type InspectionPlanQueriesReading =
  | { readonly accepted: true; readonly queries: readonly InspectionPlanQuery[] }
  | { readonly accepted: false; readonly issue: InspectionPlanQueryIssue };

type InspectionPlanQueryReading =
  | { readonly accepted: true; readonly query: InspectionPlanQuery }
  | { readonly accepted: false; readonly issue: InspectionPlanQueryIssue };

type InspectionPlanQueryReader = (
  value: Readonly<Record<string, unknown>>,
) => InspectionPlanQueryReading;

/** Reads the one canonical bounded Inspection Plan Query grammar. */
export function readInspectionPlanQueries(value: unknown): InspectionPlanQueriesReading {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INSPECTION_PLAN_QUERIES) {
      return { accepted: false, issue: "invalid-list" };
    }
    const queries: InspectionPlanQuery[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        return { accepted: false, issue: "invalid-entry" };
      }
      const reading = readInspectionPlanQuery(descriptor.value);
      if (!reading.accepted) {
        return reading;
      }
      queries.push(reading.query);
    }
    return { accepted: true, queries };
  } catch {
    return { accepted: false, issue: "invalid-entry" };
  }
}

export function isBoundedExportSearchQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_EXPORT_SEARCH_QUERY_BYTES
  );
}

/** Projects every normalized analysis request onto its canonical ordered query list. */
export function inspectionPlanQueriesForRequest(
  analysisRequest: AnalysisRequest,
): readonly InspectionPlanQuery[] {
  if (analysisRequest.intent === "inspection-plan") {
    return analysisRequest.request.queries;
  }
  switch (analysisRequest.intent) {
    case "interface-overview":
      return [{ intent: analysisRequest.intent }];
    case "export-inspection":
    case "signature-inspection":
    case "declaration-inspection":
      return [{ intent: analysisRequest.intent, exportName: analysisRequest.request.exportName }];
    case "member-inspection":
      return [
        {
          intent: analysisRequest.intent,
          exportName: analysisRequest.request.exportName,
          memberPath: analysisRequest.request.memberPath,
        },
      ];
    case "export-search":
      return [{ intent: analysisRequest.intent, query: analysisRequest.request.query }];
    case "public-subpath-discovery":
      return [{ intent: analysisRequest.intent }];
  }
}

function readInspectionPlanQuery(value: unknown): InspectionPlanQueryReading {
  const query = snapshotDataProperties(value, INSPECTION_PLAN_QUERY_FIELDS);
  if (query === undefined) {
    return { accepted: false, issue: "invalid-entry" };
  }
  const intent = query["intent"];
  return isInspectionPlanQueryIntent(intent)
    ? INSPECTION_PLAN_QUERY_READERS[intent](query)
    : { accepted: false, issue: "unsupported-intent" };
}

const INSPECTION_PLAN_QUERY_READERS = {
  "interface-overview": () => acceptedQuery({ intent: "interface-overview" }),
  "public-subpath-discovery": () => acceptedQuery({ intent: "public-subpath-discovery" }),
  "export-search": (value) => {
    const query = value["query"];
    return isBoundedExportSearchQuery(query)
      ? acceptedQuery({ intent: "export-search", query })
      : { accepted: false, issue: "invalid-search" };
  },
  "export-inspection": (value) => readFocusedPlanQuery("export-inspection", value),
  "signature-inspection": (value) => readFocusedPlanQuery("signature-inspection", value),
  "declaration-inspection": (value) => readFocusedPlanQuery("declaration-inspection", value),
  "member-inspection": readMemberPlanQuery,
} as const satisfies Readonly<Record<InspectionPlanQuery["intent"], InspectionPlanQueryReader>>;

function readFocusedPlanQuery(
  intent: "export-inspection" | "signature-inspection" | "declaration-inspection",
  value: Readonly<Record<string, unknown>>,
): InspectionPlanQueryReading {
  const exportName = value["exportName"];
  return typeof exportName === "string"
    ? acceptedQuery({ intent, exportName })
    : { accepted: false, issue: "invalid-focused" };
}

function readMemberPlanQuery(value: Readonly<Record<string, unknown>>): InspectionPlanQueryReading {
  const exportName = value["exportName"];
  const memberPath = readBoundedMemberPath(value["memberPath"]);
  return typeof exportName === "string" && memberPath !== undefined
    ? acceptedQuery({ intent: "member-inspection", exportName, memberPath })
    : { accepted: false, issue: "invalid-member" };
}

function acceptedQuery(query: InspectionPlanQuery): InspectionPlanQueryReading {
  return { accepted: true, query };
}

function isInspectionPlanQueryIntent(value: unknown): value is InspectionPlanQuery["intent"] {
  return typeof value === "string" && Object.hasOwn(INSPECTION_PLAN_QUERY_READERS, value);
}
