import { Result, Schema } from "effect";

import { memberPathSchema } from "#typepeek/inspection/member-path";
import type { AnalysisRequest, InspectionPlanQuery } from "#typepeek/inspection/protocol";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

export const MAX_INSPECTION_PLAN_QUERIES = 16;
export const MAX_EXPORT_SEARCH_QUERY_BYTES = 256;
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

const exportSearchQuerySchema = Schema.String.check(
  Schema.makeFilter(isBoundedExportSearchQuery, { expected: "a bounded search query" }),
);
const focusedPlanQuerySchemas = [
  Schema.Struct({ intent: Schema.Literal("export-inspection"), exportName: Schema.String }),
  Schema.Struct({ intent: Schema.Literal("signature-inspection"), exportName: Schema.String }),
  Schema.Struct({ intent: Schema.Literal("declaration-inspection"), exportName: Schema.String }),
] as const;
const inspectionPlanQuerySchema = Schema.Union([
  Schema.Struct({ intent: Schema.Literal("interface-overview") }),
  Schema.Struct({ intent: Schema.Literal("public-subpath-discovery") }),
  Schema.Struct({ intent: Schema.Literal("export-search"), query: exportSearchQuerySchema }),
  ...focusedPlanQuerySchemas,
  Schema.Struct({
    intent: Schema.Literal("member-inspection"),
    exportName: Schema.String,
    memberPath: memberPathSchema,
  }),
]);
export const inspectionPlanQueriesSchema = Schema.Array(inspectionPlanQuerySchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES),
);

const inspectionPlanQueryIntentSchema = Schema.Literals([
  "interface-overview",
  "export-inspection",
  "signature-inspection",
  "export-search",
  "public-subpath-discovery",
  "declaration-inspection",
  "member-inspection",
]);
const decodeInspectionPlanQueryIntent = Schema.decodeUnknownResult(inspectionPlanQueryIntentSchema);
const decodeInspectionPlanQuery = Schema.decodeUnknownResult(inspectionPlanQuerySchema);
const decodeInspectionPlanQueries = Schema.decodeUnknownResult(inspectionPlanQueriesSchema);

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
    const decoded = Result.getOrUndefined(decodeInspectionPlanQueries(queries));
    return decoded === undefined
      ? { accepted: false, issue: "invalid-entry" }
      : { accepted: true, queries: decoded };
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
  const intent = Result.getOrUndefined(decodeInspectionPlanQueryIntent(query["intent"]));
  if (intent === undefined) {
    return { accepted: false, issue: "unsupported-intent" };
  }
  const decoded = Result.getOrUndefined(decodeInspectionPlanQuery(query));
  return decoded === undefined
    ? { accepted: false, issue: issueForIntent(intent) }
    : { accepted: true, query: decoded };
}

function issueForIntent(intent: InspectionPlanQuery["intent"]): InspectionPlanQueryIssue {
  switch (intent) {
    case "export-search":
      return "invalid-search";
    case "member-inspection":
      return "invalid-member";
    case "export-inspection":
    case "signature-inspection":
    case "declaration-inspection":
      return "invalid-focused";
    case "interface-overview":
    case "public-subpath-discovery":
      return "invalid-entry";
  }
}
