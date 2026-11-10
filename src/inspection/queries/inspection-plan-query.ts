/* oxlint-disable anti-slop/no-unknown-parameters -- Plan query readers validate arbitrary transport data, including malformed arrays and accessors. */
import { Effect, Predicate, Result, Schema } from "effect";

import { exportCursorSchema } from "#typepeek/inspection/model/export-pagination";
import {
  memberDiscoveryPathSchema,
  memberPathSchema,
  readBoundedMemberPath,
} from "#typepeek/inspection/model/member-path";
import type { AnalysisRequest } from "#typepeek/inspection/model/protocol";
import { snapshotDataProperties } from "#typepeek/inspection/model/untrusted-data";
import { unreachableCase } from "#typepeek/shared/unreachable-case";

const INTERFACE_OVERVIEW = "interface-overview";
const EXPORT_INSPECTION = "export-inspection";
const SIGNATURE_INSPECTION = "signature-inspection";
const EXPORT_SEARCH = "export-search";
const PUBLIC_SUBPATH_DISCOVERY = "public-subpath-discovery";
const DECLARATION_INSPECTION = "declaration-inspection";
const MEMBER_INSPECTION = "member-inspection";
const MEMBER_DISCOVERY = "member-discovery";
const INVALID_ENTRY = "invalid-entry";

export const MAX_INSPECTION_PLAN_QUERIES = 16;
export const MAX_EXPORT_SEARCH_QUERY_BYTES = 256;

const INSPECTION_PLAN_QUERY_FIELDS = [
  "intent",
  "query",
  "exportName",
  "memberPath",
  "cursor",
  "scope",
] as const;

export type InspectionPlanQueryIssue =
  | "invalid-list"
  | "invalid-entry"
  | "unsupported-intent"
  | "invalid-search"
  | "invalid-focused"
  | "invalid-member"
  | "invalid-member-discovery";

export type InspectionPlanQueriesReading =
  | {
      readonly accepted: true;
      readonly queries: readonly InspectionPlanQuery[];
    }
  | {
      readonly accepted: false;
      readonly issue: InspectionPlanQueryIssue;
    };

type InspectionPlanQueryReading =
  | {
      readonly accepted: true;
      readonly query: InspectionPlanQuery;
    }
  | {
      readonly accepted: false;
      readonly issue: InspectionPlanQueryIssue;
    };

export const isBoundedExportSearchQuery = function isBoundedExportSearchQuery(
  value: unknown
): value is string {
  return (
    Predicate.isString(value) &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_EXPORT_SEARCH_QUERY_BYTES
  );
};

const exportSearchQuerySchema = Schema.String.check(
  Schema.makeFilter(isBoundedExportSearchQuery, {
    expected: "a bounded search query",
  })
);

export const exportSearchScopeSchema = Schema.optionalKey(
  Schema.Literal("documentation")
);

const INSPECTION_PLAN_QUERY_INTENTS = [
  INTERFACE_OVERVIEW,
  EXPORT_INSPECTION,
  SIGNATURE_INSPECTION,
  EXPORT_SEARCH,
  PUBLIC_SUBPATH_DISCOVERY,
  DECLARATION_INSPECTION,
  MEMBER_INSPECTION,
  MEMBER_DISCOVERY,
] as const;

type InspectionPlanQueryIntent = (typeof INSPECTION_PLAN_QUERY_INTENTS)[number];

const INSPECTION_PLAN_QUERY_SCHEMAS = {
  "declaration-inspection": Schema.Struct({
    exportName: Schema.String,
    intent: Schema.Literal(DECLARATION_INSPECTION),
  }),
  "export-inspection": Schema.Struct({
    exportName: Schema.String,
    intent: Schema.Literal(EXPORT_INSPECTION),
  }),
  "export-search": Schema.Struct({
    intent: Schema.Literal(EXPORT_SEARCH),
    query: exportSearchQuerySchema,
    scope: exportSearchScopeSchema,
  }),
  "interface-overview": Schema.Struct({
    cursor: Schema.optionalKey(exportCursorSchema),
    intent: Schema.Literal(INTERFACE_OVERVIEW),
  }),
  "member-discovery": Schema.Struct({
    exportName: Schema.String,
    intent: Schema.Literal(MEMBER_DISCOVERY),
    memberPath: memberDiscoveryPathSchema.pipe(
      Schema.withDecodingDefault(Effect.succeed([]))
    ),
    query: Schema.optionalKey(exportSearchQuerySchema),
  }),
  "member-inspection": Schema.Struct({
    exportName: Schema.String,
    intent: Schema.Literal(MEMBER_INSPECTION),
    memberPath: memberPathSchema,
  }),
  "public-subpath-discovery": Schema.Struct({
    intent: Schema.Literal(PUBLIC_SUBPATH_DISCOVERY),
  }),
  "signature-inspection": Schema.Struct({
    exportName: Schema.String,
    intent: Schema.Literal(SIGNATURE_INSPECTION),
  }),
} as const satisfies Readonly<
  Record<InspectionPlanQueryIntent, Schema.Constraint>
>;

const inspectionPlanQuerySchema = Schema.Union(
  Object.values(INSPECTION_PLAN_QUERY_SCHEMAS)
);

export type InspectionPlanQuery = typeof inspectionPlanQuerySchema.Type;

export const inspectionPlanQueriesSchema = Schema.Array(
  inspectionPlanQuerySchema
).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES));

const inspectionPlanQueryIntentSchema = Schema.Literals(
  INSPECTION_PLAN_QUERY_INTENTS
);

const decodeInspectionPlanQueryIntent = Schema.decodeUnknownResult(
  inspectionPlanQueryIntentSchema
);

const decodeInspectionPlanQuery = Schema.decodeUnknownResult(
  inspectionPlanQuerySchema
);

const decodeInspectionPlanQueries = Schema.decodeUnknownResult(
  inspectionPlanQueriesSchema
);

const issueForIntent = function issueForIntent(
  intent: InspectionPlanQuery["intent"]
): InspectionPlanQueryIssue {
  switch (intent) {
    case EXPORT_SEARCH: {
      return "invalid-search";
    }

    case MEMBER_INSPECTION: {
      return "invalid-member";
    }

    case MEMBER_DISCOVERY: {
      return "invalid-member-discovery";
    }

    case EXPORT_INSPECTION:
    case SIGNATURE_INSPECTION:
    case DECLARATION_INSPECTION: {
      return "invalid-focused";
    }

    case INTERFACE_OVERVIEW:
    case PUBLIC_SUBPATH_DISCOVERY: {
      return INVALID_ENTRY;
    }

    default: {
      return unreachableCase(intent);
    }
  }
};

const readInspectionPlanQuery = function readInspectionPlanQuery(
  value: unknown
): InspectionPlanQueryReading {
  const query = snapshotDataProperties(value, INSPECTION_PLAN_QUERY_FIELDS);

  if (query === undefined) {
    const identity = snapshotDataProperties(value, ["intent"]);

    return {
      accepted: false,
      issue:
        identity?.["intent"] === MEMBER_DISCOVERY
          ? "invalid-member-discovery"
          : INVALID_ENTRY,
    };
  }

  const intent = Result.getOrUndefined(
    decodeInspectionPlanQueryIntent(query["intent"])
  );

  if (intent === undefined) {
    return { accepted: false, issue: "unsupported-intent" };
  }

  let candidate = query;

  if (intent === MEMBER_INSPECTION || intent === MEMBER_DISCOVERY) {
    const memberPath = readBoundedMemberPath(
      intent === MEMBER_DISCOVERY && query["memberPath"] === undefined
        ? []
        : query["memberPath"],
      intent === MEMBER_DISCOVERY
    );

    if (memberPath === undefined) {
      return { accepted: false, issue: issueForIntent(intent) };
    }

    candidate = { ...query, memberPath };
  }

  const decoded = Result.getOrUndefined(decodeInspectionPlanQuery(candidate));

  return decoded === undefined
    ? { accepted: false, issue: issueForIntent(intent) }
    : { accepted: true, query: decoded };
};

export const readInspectionPlanQueries = function readInspectionPlanQueries(
  value: unknown
): InspectionPlanQueriesReading {
  try {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > MAX_INSPECTION_PLAN_QUERIES
    ) {
      return { accepted: false, issue: "invalid-list" };
    }

    const queries: InspectionPlanQuery[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

      if (descriptor === undefined || !("value" in descriptor)) {
        return { accepted: false, issue: INVALID_ENTRY };
      }

      const reading = readInspectionPlanQuery(descriptor.value);

      if (!reading.accepted) {
        return reading;
      }

      queries.push(reading.query);
    }

    const decoded = Result.getOrUndefined(decodeInspectionPlanQueries(queries));

    return decoded === undefined
      ? { accepted: false, issue: INVALID_ENTRY }
      : { accepted: true, queries: decoded };
  } catch {
    return { accepted: false, issue: INVALID_ENTRY };
  }
};

/** Represents atomic requests as single-query plans. */
export const inspectionPlanQueriesForRequest =
  function inspectionPlanQueriesForRequest(
    analysisRequest: AnalysisRequest
  ): readonly InspectionPlanQuery[] {
    if (analysisRequest.intent === "inspection-plan") {
      return analysisRequest.request.queries;
    }

    switch (analysisRequest.intent) {
      case INTERFACE_OVERVIEW: {
        return [
          {
            intent: analysisRequest.intent,
            ...(analysisRequest.request.cursor !== undefined && {
              cursor: analysisRequest.request.cursor,
            }),
          },
        ];
      }

      case EXPORT_INSPECTION:
      case SIGNATURE_INSPECTION:
      case DECLARATION_INSPECTION: {
        return [
          {
            exportName: analysisRequest.request.exportName,
            intent: analysisRequest.intent,
          },
        ];
      }

      case MEMBER_DISCOVERY: {
        return [
          {
            exportName: analysisRequest.request.exportName,
            intent: analysisRequest.intent,
            memberPath: analysisRequest.request.memberPath,
            ...(analysisRequest.request.query !== undefined && {
              query: analysisRequest.request.query,
            }),
          },
        ];
      }

      case MEMBER_INSPECTION: {
        return [
          {
            exportName: analysisRequest.request.exportName,
            intent: analysisRequest.intent,
            memberPath: analysisRequest.request.memberPath,
          },
        ];
      }

      case EXPORT_SEARCH: {
        return [
          {
            intent: analysisRequest.intent,
            query: analysisRequest.request.query,
            ...(analysisRequest.request.scope !== undefined && {
              scope: analysisRequest.request.scope,
            }),
          },
        ];
      }

      case PUBLIC_SUBPATH_DISCOVERY: {
        return [{ intent: analysisRequest.intent }];
      }

      default: {
        return unreachableCase(analysisRequest);
      }
    }
  };
