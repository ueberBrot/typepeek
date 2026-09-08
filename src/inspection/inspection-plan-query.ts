import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  memberPathSchema,
  memberDiscoveryPathSchema,
  readBoundedMemberPath,
} from "#typepeek/inspection/member-path";
import type { AnalysisRequest } from "#typepeek/inspection/protocol";
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
  | "invalid-member"
  | "invalid-member-discovery";

export type InspectionPlanQueriesReading =
  | { readonly accepted: true; readonly queries: readonly InspectionPlanQuery[] }
  | { readonly accepted: false; readonly issue: InspectionPlanQueryIssue };

type InspectionPlanQueryReading =
  | { readonly accepted: true; readonly query: InspectionPlanQuery }
  | { readonly accepted: false; readonly issue: InspectionPlanQueryIssue };

const exportSearchQuerySchema = Schema.String.check(
  Schema.makeFilter(isBoundedExportSearchQuery, { expected: "a bounded search query" }),
);
const INSPECTION_PLAN_QUERY_INTENTS = [
  "interface-overview",
  "export-inspection",
  "signature-inspection",
  "export-search",
  "public-subpath-discovery",
  "declaration-inspection",
  "member-inspection",
  "member-discovery",
] as const;
type InspectionPlanQueryIntent = (typeof INSPECTION_PLAN_QUERY_INTENTS)[number];
const INSPECTION_PLAN_QUERY_SCHEMAS = {
  "interface-overview": Schema.Struct({ intent: Schema.Literal("interface-overview") }),
  "export-inspection": Schema.Struct({
    intent: Schema.Literal("export-inspection"),
    exportName: Schema.String,
  }),
  "signature-inspection": Schema.Struct({
    intent: Schema.Literal("signature-inspection"),
    exportName: Schema.String,
  }),
  "export-search": Schema.Struct({
    intent: Schema.Literal("export-search"),
    query: exportSearchQuerySchema,
  }),
  "public-subpath-discovery": Schema.Struct({
    intent: Schema.Literal("public-subpath-discovery"),
  }),
  "declaration-inspection": Schema.Struct({
    intent: Schema.Literal("declaration-inspection"),
    exportName: Schema.String,
  }),
  "member-discovery": Schema.Struct({
    intent: Schema.Literal("member-discovery"),
    exportName: Schema.String,
    memberPath: memberDiscoveryPathSchema.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    query: Schema.optionalKey(exportSearchQuerySchema),
  }),
  "member-inspection": Schema.Struct({
    intent: Schema.Literal("member-inspection"),
    exportName: Schema.String,
    memberPath: memberPathSchema,
  }),
} as const satisfies Readonly<Record<InspectionPlanQueryIntent, Schema.Constraint>>;
const inspectionPlanQuerySchema = Schema.Union(Object.values(INSPECTION_PLAN_QUERY_SCHEMAS));
export type InspectionPlanQuery = typeof inspectionPlanQuerySchema.Type;

export const inspectionPlanQueriesSchema = Schema.Array(inspectionPlanQuerySchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES),
);

const inspectionPlanQueryIntentSchema = Schema.Literals(INSPECTION_PLAN_QUERY_INTENTS);
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
    case "member-discovery":
      return [
        {
          intent: analysisRequest.intent,
          exportName: analysisRequest.request.exportName,
          memberPath: analysisRequest.request.memberPath,
          ...(analysisRequest.request.query === undefined
            ? {}
            : { query: analysisRequest.request.query }),
        },
      ];
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
    const identity = snapshotDataProperties(value, ["intent"]);
    return {
      accepted: false,
      issue:
        identity?.["intent"] === "member-discovery" ? "invalid-member-discovery" : "invalid-entry",
    };
  }
  const intent = Result.getOrUndefined(decodeInspectionPlanQueryIntent(query["intent"]));
  if (intent === undefined) {
    return { accepted: false, issue: "unsupported-intent" };
  }
  let candidate = query;
  if (intent === "member-inspection" || intent === "member-discovery") {
    const memberPath = readBoundedMemberPath(
      intent === "member-discovery" && query["memberPath"] === undefined ? [] : query["memberPath"],
      intent === "member-discovery",
    );
    if (memberPath === undefined) return { accepted: false, issue: issueForIntent(intent) };
    candidate = { ...query, memberPath };
  }
  const decoded = Result.getOrUndefined(decodeInspectionPlanQuery(candidate));
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
    case "member-discovery":
      return "invalid-member-discovery";
    case "export-inspection":
    case "signature-inspection":
    case "declaration-inspection":
      return "invalid-focused";
    case "interface-overview":
    case "public-subpath-discovery":
      return "invalid-entry";
  }
}
