import nodePath from "node:path";

import { Effect, Result, Schema } from "effect";

import {
  exportCursorSchema,
  MAX_EXPORT_CURSOR_BYTES,
} from "#typepeek/inspection/model/export-pagination";
import {
  MAX_MEMBER_PATH_SEGMENT_BYTES,
  MAX_MEMBER_PATH_SEGMENTS,
  memberDeclarationSpaceSchema,
  memberDiscoveryPathSchema,
  memberPathSchema,
  readBoundedMemberPath,
} from "#typepeek/inspection/model/member-path";
import type { InspectionFailure } from "#typepeek/inspection/model/protocol";
import type {
  AnalysisIntent,
  InspectionIntent,
} from "#typepeek/inspection/model/protocol-vocabulary";
import {
  ANALYSIS_INTENTS,
  analysisIntentSchema,
  INSPECTION_INTENTS,
} from "#typepeek/inspection/model/protocol-vocabulary";
import type { SchemaDerivedRequestDescriptor } from "#typepeek/inspection/model/request-capability";
import {
  deriveInspectionRequestDescriptor,
  withRequestFieldCapability,
} from "#typepeek/inspection/model/request-capability";
/* oxlint-disable anti-slop/no-unknown-parameters -- Request readers are the schema boundary for untrusted API and IPC inputs; typed requests are produced only after safe own-property snapshots. */
import type { DataPropertySnapshot } from "#typepeek/inspection/model/untrusted-data";
import { snapshotDataProperties } from "#typepeek/inspection/model/untrusted-data";
import {
  exportSearchScopeSchema,
  inspectionPlanQueriesSchema,
  isBoundedExportSearchQuery,
  MAX_EXPORT_SEARCH_QUERY_BYTES,
  MAX_INSPECTION_PLAN_QUERIES,
  readInspectionPlanQueries,
} from "#typepeek/inspection/queries/inspection-plan-query";

const ABSOLUTE_PATH = "absolute-path";
const EXAMPLE_RESOLUTION_CONTEXT = "/absolute/path/to/consumer";

interface InspectionRequestDefinition<
  Intent extends InspectionIntent,
  RequestSchema extends Schema.Struct<Schema.Struct.Fields> &
    Schema.ConstraintDecoder<unknown>,
> {
  readonly intent: Intent;
  readonly schema: RequestSchema;
  readonly envelopeSchema: Schema.Struct<{
    readonly intent: Schema.Literal<Intent>;
    readonly request: RequestSchema;
  }>;
  readonly invalidOutcome: InspectionFailure;
  readonly read: (
    value: unknown
  ) => NormalizedInspectionRequestByIntent[Intent] | undefined;
}

type RequestFieldEntry = readonly [name: string, schema: Schema.Top];

type RequestFields<Entries extends readonly RequestFieldEntry[]> = {
  readonly [Entry in Entries[number] as Entry[0]]: Entry[1];
};

type RequestFieldNames<Entries extends readonly RequestFieldEntry[]> = {
  readonly [Index in keyof Entries]: Entries[Index][0];
};

const requestFields = function requestFields<
  const Entries extends readonly RequestFieldEntry[],
>(entries: Entries): RequestFields<Entries> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Object.fromEntries retains each entry's name and schema; the mapped type expresses that correspondence.
  return Object.fromEntries(entries) as RequestFields<Entries>;
};

const requestFieldNames = function requestFieldNames<
  const Entries extends readonly RequestFieldEntry[],
>(entries: Entries): RequestFieldNames<Entries> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Mapping only the first tuple element preserves every name and its position before freezing the result.
  return Object.freeze(
    entries.map(([name]) => name)
  ) as RequestFieldNames<Entries>;
};

const accessStyleSchema = Schema.Literals(["import", "require"]);

const resolutionContextSchema = withRequestFieldCapability(
  Schema.String.check(
    Schema.makeFilter((path) => nodePath.isAbsolute(path), {
      expected: "an absolute path",
    })
  ),
  { format: ABSOLUTE_PATH, kind: "string" }
);

const specifierSchema = withRequestFieldCapability(Schema.String, {
  kind: "string",
});

const requestAccessStyleSchema = withRequestFieldCapability(
  accessStyleSchema.pipe(Schema.withDecodingDefault(Effect.succeed("import"))),
  { default: "import", kind: "enum", values: accessStyleSchema.literals }
);

const exportNameSchema = withRequestFieldCapability(Schema.String, {
  kind: "string",
});

const exportSearchQuerySchema = withRequestFieldCapability(
  Schema.String.check(
    Schema.makeFilter(isBoundedExportSearchQuery, {
      expected: "a bounded search query",
    })
  ),
  { kind: "string", maxBytes: MAX_EXPORT_SEARCH_QUERY_BYTES, minBytes: 1 }
);

const requestMemberPathSchema = withRequestFieldCapability(memberPathSchema, {
  kind: "member-path",
  maxItemBytes: MAX_MEMBER_PATH_SEGMENT_BYTES,
  maxItems: MAX_MEMBER_PATH_SEGMENTS,
  minItems: 1,
  qualified: {
    name: "name",
    space: "space",
    values: memberDeclarationSpaceSchema.literals,
  },
  unqualified: true,
});

const requestDiscoveryMemberPathSchema = withRequestFieldCapability(
  memberDiscoveryPathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed([]))
  ),
  {
    kind: "member-path",
    maxItemBytes: MAX_MEMBER_PATH_SEGMENT_BYTES,
    maxItems: MAX_MEMBER_PATH_SEGMENTS,
    minItems: 0,
    qualified: {
      name: "name",
      space: "space",
      values: memberDeclarationSpaceSchema.literals,
    },
    unqualified: true,
  }
);

const requestDiscoveryQuerySchema = withRequestFieldCapability(
  Schema.optionalKey(exportSearchQuerySchema),
  { kind: "string", maxBytes: MAX_EXPORT_SEARCH_QUERY_BYTES, minBytes: 1 }
);

const requestPlanQueriesSchema = withRequestFieldCapability(
  inspectionPlanQueriesSchema,
  {
    kind: "inspection-plan-queries",
    maxItems: MAX_INSPECTION_PLAN_QUERIES,
    minItems: 1,
  }
);

const TARGET_FIELD_ENTRIES = [
  ["resolutionContext", resolutionContextSchema],
  ["specifier", specifierSchema],
  ["accessStyle", requestAccessStyleSchema],
] as const;

const EXPORT_FIELD_ENTRIES = [
  ...TARGET_FIELD_ENTRIES,
  ["exportName", exportNameSchema],
] as const;

const OVERVIEW_FIELD_ENTRIES = [
  ...TARGET_FIELD_ENTRIES,
  [
    "cursor",
    withRequestFieldCapability(Schema.optionalKey(exportCursorSchema), {
      kind: "string",
      maxBytes: MAX_EXPORT_CURSOR_BYTES,
    }),
  ],
] as const;

const EXPORT_SEARCH_FIELD_ENTRIES = [
  ...TARGET_FIELD_ENTRIES,
  ["query", exportSearchQuerySchema],
  [
    "scope",
    withRequestFieldCapability(exportSearchScopeSchema, {
      kind: "enum",
      values: ["documentation"],
    }),
  ],
] as const;

const MEMBER_FIELD_ENTRIES = [
  ...EXPORT_FIELD_ENTRIES,
  ["memberPath", requestMemberPathSchema],
] as const;

const MEMBER_DISCOVERY_FIELD_ENTRIES = [
  ...EXPORT_FIELD_ENTRIES,
  ["memberPath", requestDiscoveryMemberPathSchema],
  ["query", requestDiscoveryQuerySchema],
] as const;

const PLAN_FIELD_ENTRIES = [
  ...TARGET_FIELD_ENTRIES,
  ["queries", requestPlanQueriesSchema],
] as const;

const normalizedTargetSchema = Schema.Struct(
  requestFields(TARGET_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
    specifier: "zod",
  },
});

const normalizedExportSchema = Schema.Struct(
  requestFields(EXPORT_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    exportName: "ZodError",
    resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
    specifier: "zod",
  },
});

const normalizedExportSearchSchema = Schema.Struct(
  requestFields(EXPORT_SEARCH_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    query: "Error",
    resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
    specifier: "zod",
  },
});

const normalizedMemberSchema = Schema.Struct(
  requestFields(MEMBER_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    exportName: "ZodError",
    memberPath: ["issues"],
    resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
    specifier: "zod",
  },
});

const normalizedMemberDiscoverySchema = Schema.Struct(
  requestFields(MEMBER_DISCOVERY_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    exportName: "ZodError",
    resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
    specifier: "zod",
  },
});

const normalizedPlanSchema = Schema.Struct(
  requestFields(PLAN_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    queries: [{ intent: "interface-overview" }],
    resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
    specifier: "zod",
  },
});

const COMPARISON_FIELD_ENTRIES = [
  [
    "before",
    withRequestFieldCapability(normalizedTargetSchema, {
      kind: "inspection-target",
      resolutionContextFormat: ABSOLUTE_PATH,
    }),
  ],
  [
    "after",
    withRequestFieldCapability(normalizedTargetSchema, {
      kind: "inspection-target",
      resolutionContextFormat: ABSOLUTE_PATH,
    }),
  ],
] as const;

const normalizedComparisonSchema = Schema.Struct(
  requestFields(COMPARISON_FIELD_ENTRIES)
).annotate({
  inspectionRequestExample: {
    after: {
      resolutionContext: "/absolute/path/to/after-consumer",
      specifier: "zod",
    },
    before: {
      resolutionContext: "/absolute/path/to/before-consumer",
      specifier: "zod",
    },
  },
});

export const inspectionRequestSchemas = {
  "declaration-inspection": normalizedExportSchema,
  "export-inspection": normalizedExportSchema,
  "export-search": normalizedExportSearchSchema,
  "inspection-plan": normalizedPlanSchema,
  "interface-overview": Schema.Struct(
    requestFields(OVERVIEW_FIELD_ENTRIES)
  ).annotate({
    inspectionRequestExample: {
      cursor: "start",
      resolutionContext: EXAMPLE_RESOLUTION_CONTEXT,
      specifier: "zod",
    },
  }),
  "member-discovery": normalizedMemberDiscoverySchema,
  "member-inspection": normalizedMemberSchema,
  "public-interface-comparison": normalizedComparisonSchema,
  "public-subpath-discovery": normalizedTargetSchema,
  "signature-inspection": normalizedExportSchema,
} as const satisfies Readonly<Record<InspectionIntent, Schema.Constraint>>;

export const inspectionRequestFieldNames = Object.freeze({
  "declaration-inspection": requestFieldNames(EXPORT_FIELD_ENTRIES),
  "export-inspection": requestFieldNames(EXPORT_FIELD_ENTRIES),
  "export-search": requestFieldNames(EXPORT_SEARCH_FIELD_ENTRIES),
  "inspection-plan": requestFieldNames(PLAN_FIELD_ENTRIES),
  "interface-overview": requestFieldNames(OVERVIEW_FIELD_ENTRIES),
  "member-discovery": requestFieldNames(MEMBER_DISCOVERY_FIELD_ENTRIES),
  "member-inspection": requestFieldNames(MEMBER_FIELD_ENTRIES),
  "public-interface-comparison": requestFieldNames(COMPARISON_FIELD_ENTRIES),
  "public-subpath-discovery": requestFieldNames(TARGET_FIELD_ENTRIES),
  "signature-inspection": requestFieldNames(EXPORT_FIELD_ENTRIES),
} as const satisfies Readonly<Record<InspectionIntent, readonly string[]>>);

export type InspectionRequestByIntent = {
  readonly [
    Intent in InspectionIntent
  ]: (typeof inspectionRequestSchemas)[Intent]["Encoded"];
};

export type NormalizedInspectionRequestByIntent = {
  readonly [
    Intent in InspectionIntent
  ]: (typeof inspectionRequestSchemas)[Intent]["Type"];
};

export type AccessStyle = NormalizedInspectionTarget["accessStyle"];

export type InterfaceOverviewRequest =
  InspectionRequestByIntent["interface-overview"];

export type NormalizedInspectionTarget = typeof normalizedTargetSchema.Type;

export type ExportInspectionRequest =
  InspectionRequestByIntent["export-inspection"];

export type SignatureInspectionRequest =
  InspectionRequestByIntent["signature-inspection"];

export type ExportSearchRequest = InspectionRequestByIntent["export-search"];

export type PublicSubpathDiscoveryRequest =
  InspectionRequestByIntent["public-subpath-discovery"];

export type DeclarationInspectionRequest =
  InspectionRequestByIntent["declaration-inspection"];

export type MemberDiscoveryRequest =
  InspectionRequestByIntent["member-discovery"];

export type MemberInspectionRequest =
  InspectionRequestByIntent["member-inspection"];

export type InspectionPlanRequest =
  InspectionRequestByIntent["inspection-plan"];

export type NormalizedInspectionPlanRequest =
  NormalizedInspectionRequestByIntent["inspection-plan"];

export type PublicInterfaceComparisonRequest =
  InspectionRequestByIntent["public-interface-comparison"];

export type NormalizedPublicInterfaceComparisonRequest =
  NormalizedInspectionRequestByIntent["public-interface-comparison"];

export type InspectionRequestReading<Request> =
  | {
      readonly accepted: true;
      readonly request: Request;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

const INVALID_ANALYSIS_REQUEST_OUTCOME: InspectionFailure = {
  message: "Inspection received an invalid request.",
  reason: "invalid-request",
  status: "unsupported",
};

const ANALYSIS_REQUEST_FIELDS = ["intent", "request"] as const;

const defineRequest = function defineRequest<
  Intent extends InspectionIntent,
  RequestSchema extends Schema.Struct<Schema.Struct.Fields> &
    Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]>,
>(definition: {
  readonly intent: Intent;
  readonly schema: RequestSchema;
  readonly invalidOutcome: InspectionFailure;
  readonly prepareCandidate?: (
    candidate: DataPropertySnapshot
  ) => DataPropertySnapshot | undefined;
}): InspectionRequestDefinition<Intent, RequestSchema> {
  const fieldNames = Object.keys(definition.schema.fields);
  const decode = Schema.decodeUnknownResult(definition.schema);

  const envelopeSchema = Schema.Struct({
    intent: Schema.Literal(definition.intent),
    request: definition.schema,
  });

  const invalidOutcome = Object.freeze(definition.invalidOutcome);

  return Object.freeze({
    envelopeSchema,
    intent: definition.intent,
    invalidOutcome,
    read(
      value: unknown
    ): NormalizedInspectionRequestByIntent[Intent] | undefined {
      try {
        const candidate = snapshotDataProperties(value, fieldNames);

        if (candidate === undefined) {
          return undefined;
        }

        const prepared =
          definition.prepareCandidate === undefined
            ? candidate
            : definition.prepareCandidate(candidate);

        return prepared === undefined
          ? undefined
          : Result.getOrUndefined(decode(prepared));
      } catch {
        return undefined;
      }
    },
    schema: definition.schema,
  } satisfies InspectionRequestDefinition<Intent, RequestSchema>);
};

const invalidRequest = function invalidRequest(
  name: string
): InspectionFailure {
  return {
    message: `Inspection received an invalid ${name} request.`,
    reason: "invalid-request",
    status: "unsupported",
  };
};

const preparePlanCandidate = function preparePlanCandidate(
  value: DataPropertySnapshot
): DataPropertySnapshot | undefined {
  const queries = readInspectionPlanQueries(value["queries"]);

  return queries.accepted ? { ...value, queries: queries.queries } : undefined;
};

const prepareMemberCandidate = function prepareMemberCandidate(
  value: DataPropertySnapshot
): DataPropertySnapshot | undefined {
  const memberPath = readBoundedMemberPath(value["memberPath"]);

  return memberPath === undefined ? undefined : { ...value, memberPath };
};

const interfaceOverviewRequestDefinition = defineRequest({
  intent: "interface-overview",
  invalidOutcome: invalidRequest("Interface Overview"),
  schema: inspectionRequestSchemas["interface-overview"],
});

const prepareComparisonCandidate = function prepareComparisonCandidate(
  value: DataPropertySnapshot
): DataPropertySnapshot | undefined {
  const before = interfaceOverviewRequestDefinition.read(value["before"]);
  const after = interfaceOverviewRequestDefinition.read(value["after"]);

  if (before === undefined || after === undefined) {
    return undefined;
  }

  return before.cursor !== undefined || after.cursor !== undefined
    ? undefined
    : { after, before };
};

type InspectionRequestDefinitions = {
  readonly [Intent in InspectionIntent]: InspectionRequestDefinition<
    Intent,
    (typeof inspectionRequestSchemas)[Intent]
  >;
};

const REQUEST_DEFINITIONS: InspectionRequestDefinitions = Object.freeze({
  "declaration-inspection": defineRequest({
    intent: "declaration-inspection",
    invalidOutcome: invalidRequest("Declaration Inspection"),
    schema: inspectionRequestSchemas["declaration-inspection"],
  }),
  "export-inspection": defineRequest({
    intent: "export-inspection",
    invalidOutcome: invalidRequest("Export Inspection"),
    schema: inspectionRequestSchemas["export-inspection"],
  }),
  "export-search": defineRequest({
    intent: "export-search",
    invalidOutcome: invalidRequest("Export Search"),
    schema: inspectionRequestSchemas["export-search"],
  }),
  "inspection-plan": defineRequest({
    intent: "inspection-plan",
    invalidOutcome: invalidRequest("Inspection Plan"),
    prepareCandidate: preparePlanCandidate,
    schema: inspectionRequestSchemas["inspection-plan"],
  }),
  "interface-overview": interfaceOverviewRequestDefinition,
  "member-discovery": defineRequest({
    intent: "member-discovery",
    invalidOutcome: invalidRequest("Member Discovery"),
    prepareCandidate(value) {
      const memberPath = readBoundedMemberPath(
        value["memberPath"] === undefined ? [] : value["memberPath"],
        true
      );

      return memberPath === undefined ? undefined : { ...value, memberPath };
    },
    schema: inspectionRequestSchemas["member-discovery"],
  }),
  "member-inspection": defineRequest({
    intent: "member-inspection",
    invalidOutcome: invalidRequest("Member Inspection"),
    prepareCandidate: prepareMemberCandidate,
    schema: inspectionRequestSchemas["member-inspection"],
  }),
  "public-interface-comparison": defineRequest({
    intent: "public-interface-comparison",
    invalidOutcome: invalidRequest("Public Interface Comparison"),
    prepareCandidate: (value) => prepareComparisonCandidate(value),
    schema: inspectionRequestSchemas["public-interface-comparison"],
  }),
  "public-subpath-discovery": defineRequest({
    intent: "public-subpath-discovery",
    invalidOutcome: invalidRequest("Public Subpath Discovery"),
    schema: inspectionRequestSchemas["public-subpath-discovery"],
  }),
  "signature-inspection": defineRequest({
    intent: "signature-inspection",
    invalidOutcome: invalidRequest("Signature Inspection"),
    schema: inspectionRequestSchemas["signature-inspection"],
  }),
});

export const analysisRequestSchema = Schema.Union(
  ANALYSIS_INTENTS.map((intent) => REQUEST_DEFINITIONS[intent].envelopeSchema)
);

export type AnalysisRequest = typeof analysisRequestSchema.Type;

export type AnalysisRequestReading =
  | {
      readonly accepted: true;
      readonly request: AnalysisRequest;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

export type PreparedInspectionCoreRequest =
  | AnalysisRequest
  | {
      readonly intent: "public-interface-comparison";
      readonly request: NormalizedPublicInterfaceComparisonRequest;
    };

export type InspectionCoreRequestReading =
  | {
      readonly accepted: true;
      readonly preparedRequest: PreparedInspectionCoreRequest;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

const decodeAnalysisIntent = Schema.decodeUnknownResult(analysisIntentSchema);
const decodeAnalysisRequest = Schema.decodeUnknownResult(analysisRequestSchema);

export const INSPECTION_REQUEST_DESCRIPTORS = Object.freeze(
  INSPECTION_INTENTS.map((intent) =>
    deriveInspectionRequestDescriptor(
      intent,
      REQUEST_DEFINITIONS[intent].schema
    )
  )
) satisfies readonly SchemaDerivedRequestDescriptor[];

export const readInspectionRequest = function readInspectionRequest<
  Intent extends InspectionIntent,
>(
  intent: Intent,
  value: unknown
): InspectionRequestReading<NormalizedInspectionRequestByIntent[Intent]> {
  const request = REQUEST_DEFINITIONS[intent].read(value);

  return request === undefined
    ? { accepted: false, outcome: REQUEST_DEFINITIONS[intent].invalidOutcome }
    : { accepted: true, request };
};

const readAnalysisRequestForIntent = function readAnalysisRequestForIntent(
  intent: AnalysisIntent,
  value: unknown
): AnalysisRequestReading {
  const reading = readInspectionRequest(intent, value);

  if (!reading.accepted) {
    return reading;
  }

  const request = Result.getOrUndefined(
    decodeAnalysisRequest({ intent, request: reading.request })
  );

  return request === undefined
    ? { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME }
    : { accepted: true, request };
};

export const readInspectionCoreRequest = function readInspectionCoreRequest(
  intent: InspectionIntent,
  value: unknown
): InspectionCoreRequestReading {
  if (intent === "public-interface-comparison") {
    const reading = readInspectionRequest(intent, value);

    return reading.accepted
      ? {
          accepted: true,
          preparedRequest: { intent, request: reading.request },
        }
      : reading;
  }

  const reading = readAnalysisRequestForIntent(intent, value);

  return reading.accepted
    ? { accepted: true, preparedRequest: reading.request }
    : reading;
};

/** Validates the request received by the analysis subprocess. */
export const readAnalysisRequest = function readAnalysisRequest(
  value: unknown
): AnalysisRequestReading {
  try {
    const envelope = snapshotDataProperties(value, ANALYSIS_REQUEST_FIELDS);

    const intent = Result.getOrUndefined(
      decodeAnalysisIntent(envelope?.["intent"])
    );

    if (intent === undefined) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }

    const reading = readAnalysisRequestForIntent(intent, envelope?.["request"]);

    if (!reading.accepted) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }

    return reading;
  } catch {
    return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
};
