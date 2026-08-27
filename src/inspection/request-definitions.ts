import { Effect, Result, Schema } from "effect";
import { isAbsolute } from "node:path";

import {
  inspectionPlanQueriesSchema,
  isBoundedExportSearchQuery,
  MAX_EXPORT_SEARCH_QUERY_BYTES,
  MAX_INSPECTION_PLAN_QUERIES,
  readInspectionPlanQueries,
} from "#typepeek/inspection/inspection-plan-query";
import {
  memberPathSchema,
  MAX_MEMBER_PATH_SEGMENTS,
  MAX_MEMBER_PATH_SEGMENT_BYTES,
  readBoundedMemberPath,
} from "#typepeek/inspection/member-path";
import type { InspectionFailure } from "#typepeek/inspection/protocol";
import {
  ANALYSIS_INTENTS,
  analysisIntentSchema,
  type AnalysisIntent,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  deriveInspectionRequestDescriptor,
  type SchemaDerivedRequestDescriptor,
  withRequestFieldCapability,
} from "#typepeek/inspection/request-capability";
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

type InspectionRequestDefinition<
  Intent extends InspectionIntent,
  RequestSchema extends Schema.Struct<Schema.Struct.Fields> &
    Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]> =
    Schema.Struct<Schema.Struct.Fields> &
      Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]>,
> = {
  readonly intent: Intent;
  readonly schema: RequestSchema;
  readonly envelopeSchema: Schema.Struct<{
    readonly intent: Schema.Literal<Intent>;
    readonly request: RequestSchema;
  }>;
  readonly invalidOutcome: InspectionFailure;
  readonly read: (value: unknown) => NormalizedInspectionRequestByIntent[Intent] | undefined;
};

type RequestFieldEntry = readonly [name: string, schema: Schema.Top];
type RequestFields<Entries extends readonly RequestFieldEntry[]> = {
  readonly [Entry in Entries[number] as Entry[0]]: Entry[1];
};
type RequestFieldNames<Entries extends readonly RequestFieldEntry[]> = {
  readonly [Index in keyof Entries]: Entries[Index][0];
};

function requestFields<const Entries extends readonly RequestFieldEntry[]>(
  entries: Entries,
): RequestFields<Entries> {
  return Object.fromEntries(entries) as RequestFields<Entries>;
}

function requestFieldNames<const Entries extends readonly RequestFieldEntry[]>(
  entries: Entries,
): RequestFieldNames<Entries> {
  return Object.freeze(entries.map(([name]) => name)) as RequestFieldNames<Entries>;
}

const accessStyleSchema = Schema.Literals(["import", "require"]);
const resolutionContextSchema = withRequestFieldCapability(
  Schema.String.check(Schema.makeFilter(isAbsolute, { expected: "an absolute path" })),
  { kind: "string", format: "absolute-path" },
);
const specifierSchema = withRequestFieldCapability(Schema.String, { kind: "string" });
const requestAccessStyleSchema = withRequestFieldCapability(
  accessStyleSchema.pipe(Schema.withDecodingDefault(Effect.succeed("import"))),
  { kind: "enum", values: accessStyleSchema.literals, default: "import" },
);
const exportNameSchema = withRequestFieldCapability(Schema.String, { kind: "string" });
const exportSearchQuerySchema = withRequestFieldCapability(
  Schema.String.check(
    Schema.makeFilter(isBoundedExportSearchQuery, { expected: "a bounded search query" }),
  ),
  { kind: "string", minBytes: 1, maxBytes: MAX_EXPORT_SEARCH_QUERY_BYTES },
);
const requestMemberPathSchema = withRequestFieldCapability(memberPathSchema, {
  kind: "member-path",
  minItems: 1,
  maxItems: MAX_MEMBER_PATH_SEGMENTS,
  maxItemBytes: MAX_MEMBER_PATH_SEGMENT_BYTES,
});
const requestPlanQueriesSchema = withRequestFieldCapability(inspectionPlanQueriesSchema, {
  kind: "inspection-plan-queries",
  minItems: 1,
  maxItems: MAX_INSPECTION_PLAN_QUERIES,
});
const TARGET_FIELD_ENTRIES = [
  ["resolutionContext", resolutionContextSchema],
  ["specifier", specifierSchema],
  ["accessStyle", requestAccessStyleSchema],
] as const;
const EXPORT_FIELD_ENTRIES = [...TARGET_FIELD_ENTRIES, ["exportName", exportNameSchema]] as const;
const EXPORT_SEARCH_FIELD_ENTRIES = [
  ...TARGET_FIELD_ENTRIES,
  ["query", exportSearchQuerySchema],
] as const;
const MEMBER_FIELD_ENTRIES = [
  ...EXPORT_FIELD_ENTRIES,
  ["memberPath", requestMemberPathSchema],
] as const;
const PLAN_FIELD_ENTRIES = [
  ...TARGET_FIELD_ENTRIES,
  ["queries", requestPlanQueriesSchema],
] as const;

const normalizedTargetSchema = Schema.Struct(requestFields(TARGET_FIELD_ENTRIES)).annotate({
  inspectionRequestExample: {
    resolutionContext: "/absolute/path/to/consumer",
    specifier: "zod",
  },
});
const normalizedExportSchema = Schema.Struct(requestFields(EXPORT_FIELD_ENTRIES)).annotate({
  inspectionRequestExample: {
    resolutionContext: "/absolute/path/to/consumer",
    specifier: "zod",
    exportName: "ZodError",
  },
});
const normalizedExportSearchSchema = Schema.Struct(
  requestFields(EXPORT_SEARCH_FIELD_ENTRIES),
).annotate({
  inspectionRequestExample: {
    resolutionContext: "/absolute/path/to/consumer",
    specifier: "zod",
    query: "Error",
  },
});
const normalizedMemberSchema = Schema.Struct(requestFields(MEMBER_FIELD_ENTRIES)).annotate({
  inspectionRequestExample: {
    resolutionContext: "/absolute/path/to/consumer",
    specifier: "zod",
    exportName: "ZodError",
    memberPath: ["issues"],
  },
});
const normalizedPlanSchema = Schema.Struct(requestFields(PLAN_FIELD_ENTRIES)).annotate({
  inspectionRequestExample: {
    resolutionContext: "/absolute/path/to/consumer",
    specifier: "zod",
    queries: [{ intent: "interface-overview" }],
  },
});
const COMPARISON_FIELD_ENTRIES = [
  [
    "before",
    withRequestFieldCapability(normalizedTargetSchema, {
      kind: "inspection-target",
      resolutionContextFormat: "absolute-path",
    }),
  ],
  [
    "after",
    withRequestFieldCapability(normalizedTargetSchema, {
      kind: "inspection-target",
      resolutionContextFormat: "absolute-path",
    }),
  ],
] as const;
const normalizedComparisonSchema = Schema.Struct(requestFields(COMPARISON_FIELD_ENTRIES)).annotate({
  inspectionRequestExample: {
    before: {
      resolutionContext: "/absolute/path/to/before-consumer",
      specifier: "zod",
    },
    after: {
      resolutionContext: "/absolute/path/to/after-consumer",
      specifier: "zod",
    },
  },
});
export const inspectionRequestSchemas = {
  "interface-overview": normalizedTargetSchema,
  "export-inspection": normalizedExportSchema,
  "signature-inspection": normalizedExportSchema,
  "export-search": normalizedExportSearchSchema,
  "public-subpath-discovery": normalizedTargetSchema,
  "declaration-inspection": normalizedExportSchema,
  "member-inspection": normalizedMemberSchema,
  "inspection-plan": normalizedPlanSchema,
  "public-interface-comparison": normalizedComparisonSchema,
} as const satisfies Readonly<Record<InspectionIntent, Schema.Constraint>>;
export const inspectionRequestFieldNames = Object.freeze({
  "interface-overview": requestFieldNames(TARGET_FIELD_ENTRIES),
  "export-inspection": requestFieldNames(EXPORT_FIELD_ENTRIES),
  "signature-inspection": requestFieldNames(EXPORT_FIELD_ENTRIES),
  "export-search": requestFieldNames(EXPORT_SEARCH_FIELD_ENTRIES),
  "public-subpath-discovery": requestFieldNames(TARGET_FIELD_ENTRIES),
  "declaration-inspection": requestFieldNames(EXPORT_FIELD_ENTRIES),
  "member-inspection": requestFieldNames(MEMBER_FIELD_ENTRIES),
  "inspection-plan": requestFieldNames(PLAN_FIELD_ENTRIES),
  "public-interface-comparison": requestFieldNames(COMPARISON_FIELD_ENTRIES),
} as const satisfies Readonly<Record<InspectionIntent, readonly string[]>>);

export type InspectionRequestByIntent = {
  readonly [Intent in InspectionIntent]: (typeof inspectionRequestSchemas)[Intent]["Encoded"];
};

export type NormalizedInspectionRequestByIntent = {
  readonly [Intent in InspectionIntent]: (typeof inspectionRequestSchemas)[Intent]["Type"];
};

export type AccessStyle = NormalizedInspectionTarget["accessStyle"];
export type InterfaceOverviewRequest = InspectionRequestByIntent["interface-overview"];
export type NormalizedInspectionTarget = NormalizedInspectionRequestByIntent["interface-overview"];
export type ExportInspectionRequest = InspectionRequestByIntent["export-inspection"];
export type SignatureInspectionRequest = InspectionRequestByIntent["signature-inspection"];
export type ExportSearchRequest = InspectionRequestByIntent["export-search"];
export type PublicSubpathDiscoveryRequest = InspectionRequestByIntent["public-subpath-discovery"];
export type DeclarationInspectionRequest = InspectionRequestByIntent["declaration-inspection"];
export type NormalizedDeclarationInspectionRequest =
  NormalizedInspectionRequestByIntent["declaration-inspection"];
export type MemberInspectionRequest = InspectionRequestByIntent["member-inspection"];
export type NormalizedMemberInspectionRequest =
  NormalizedInspectionRequestByIntent["member-inspection"];
export type InspectionPlanRequest = InspectionRequestByIntent["inspection-plan"];
export type NormalizedInspectionPlanRequest =
  NormalizedInspectionRequestByIntent["inspection-plan"];
export type PublicInterfaceComparisonRequest =
  InspectionRequestByIntent["public-interface-comparison"];
export type NormalizedPublicInterfaceComparisonRequest =
  NormalizedInspectionRequestByIntent["public-interface-comparison"];

export type InspectionRequestReading<Request> =
  | { readonly accepted: true; readonly request: Request }
  | { readonly accepted: false; readonly outcome: InspectionFailure };

const INVALID_ANALYSIS_REQUEST_OUTCOME: InspectionFailure = {
  status: "unsupported",
  reason: "invalid-request",
  message: "Inspection received an invalid request.",
};
const ANALYSIS_REQUEST_FIELDS = ["intent", "request"] as const;

const REQUEST_DEFINITIONS = Object.freeze({
  "interface-overview": defineRequest({
    intent: "interface-overview",
    schema: inspectionRequestSchemas["interface-overview"],
    invalidOutcome: invalidRequest("Interface Overview"),
  }),
  "export-inspection": defineRequest({
    intent: "export-inspection",
    schema: inspectionRequestSchemas["export-inspection"],
    invalidOutcome: invalidRequest("Export Inspection"),
  }),
  "signature-inspection": defineRequest({
    intent: "signature-inspection",
    schema: inspectionRequestSchemas["signature-inspection"],
    invalidOutcome: invalidRequest("Signature Inspection"),
  }),
  "export-search": defineRequest({
    intent: "export-search",
    schema: inspectionRequestSchemas["export-search"],
    invalidOutcome: invalidRequest("Export Search"),
  }),
  "public-subpath-discovery": defineRequest({
    intent: "public-subpath-discovery",
    schema: inspectionRequestSchemas["public-subpath-discovery"],
    invalidOutcome: invalidRequest("Public Subpath Discovery"),
  }),
  "declaration-inspection": defineRequest({
    intent: "declaration-inspection",
    schema: inspectionRequestSchemas["declaration-inspection"],
    invalidOutcome: invalidRequest("Declaration Inspection"),
  }),
  "member-inspection": defineRequest({
    intent: "member-inspection",
    schema: inspectionRequestSchemas["member-inspection"],
    invalidOutcome: invalidRequest("Member Inspection"),
    prepareCandidate: prepareMemberCandidate,
  }),
  "inspection-plan": defineRequest({
    intent: "inspection-plan",
    schema: inspectionRequestSchemas["inspection-plan"],
    invalidOutcome: invalidRequest("Inspection Plan"),
    prepareCandidate: preparePlanCandidate,
  }),
  "public-interface-comparison": defineRequest({
    intent: "public-interface-comparison",
    schema: inspectionRequestSchemas["public-interface-comparison"],
    invalidOutcome: invalidRequest("Public Interface Comparison"),
    prepareCandidate: prepareComparisonCandidate,
  }),
} as const satisfies {
  readonly [Intent in InspectionIntent]: InspectionRequestDefinition<Intent>;
});

export const analysisRequestSchema = Schema.Union(
  ANALYSIS_INTENTS.map((intent) => REQUEST_DEFINITIONS[intent].envelopeSchema),
);
export type AnalysisRequest = typeof analysisRequestSchema.Type;

export type AnalysisRequestReading =
  | { readonly accepted: true; readonly request: AnalysisRequest }
  | { readonly accepted: false; readonly outcome: InspectionFailure };

export type PreparedInspectionCoreRequest =
  | AnalysisRequest
  | {
      readonly intent: "public-interface-comparison";
      readonly request: NormalizedPublicInterfaceComparisonRequest;
    };

export type InspectionCoreRequestReading =
  | { readonly accepted: true; readonly preparedRequest: PreparedInspectionCoreRequest }
  | { readonly accepted: false; readonly outcome: InspectionFailure };

const decodeAnalysisIntent = Schema.decodeUnknownResult(analysisIntentSchema);
const decodeAnalysisRequest = Schema.decodeUnknownResult(analysisRequestSchema);

export const INSPECTION_REQUEST_DESCRIPTORS = Object.freeze(
  Object.values(REQUEST_DEFINITIONS).map(({ intent, schema }) =>
    deriveInspectionRequestDescriptor(intent, schema),
  ),
) satisfies readonly SchemaDerivedRequestDescriptor[];

/** Validates one untrusted caller request through its published executable definition. */
export function readInspectionRequest<Intent extends InspectionIntent>(
  intent: Intent,
  value: unknown,
): InspectionRequestReading<NormalizedInspectionRequestByIntent[Intent]> {
  const request = REQUEST_DEFINITIONS[intent].read(value) as
    | NormalizedInspectionRequestByIntent[Intent]
    | undefined;
  return request === undefined
    ? { accepted: false, outcome: REQUEST_DEFINITIONS[intent].invalidOutcome }
    : { accepted: true, request };
}

/** Validates and correlates one analysis intent with its normalized request. */
function readAnalysisRequestForIntent(
  intent: AnalysisIntent,
  value: unknown,
): AnalysisRequestReading {
  const reading = readInspectionRequest(intent, value);
  if (!reading.accepted) {
    return reading;
  }
  const request = Result.getOrUndefined(
    decodeAnalysisRequest({ intent, request: reading.request }),
  );
  return request === undefined
    ? { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME }
    : { accepted: true, request };
}

/** Validates and correlates one transport-neutral Inspection Core request. */
export function readInspectionCoreRequest(
  intent: InspectionIntent,
  value: unknown,
): InspectionCoreRequestReading {
  if (intent === "public-interface-comparison") {
    const reading = readInspectionRequest(intent, value);
    return reading.accepted
      ? { accepted: true, preparedRequest: { intent, request: reading.request } }
      : reading;
  }
  const reading = readAnalysisRequestForIntent(intent, value);
  return reading.accepted ? { accepted: true, preparedRequest: reading.request } : reading;
}

/** Revalidates the structured-cloned request at the isolated analysis-process seam. */
export function readAnalysisRequest(value: unknown): AnalysisRequestReading {
  try {
    const envelope = snapshotDataProperties(value, ANALYSIS_REQUEST_FIELDS);
    const intent = Result.getOrUndefined(decodeAnalysisIntent(envelope?.["intent"]));
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
}

function defineRequest<
  Intent extends InspectionIntent,
  RequestSchema extends Schema.Struct<Schema.Struct.Fields> &
    Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]>,
>(definition: {
  readonly intent: Intent;
  readonly schema: RequestSchema;
  readonly invalidOutcome: InspectionFailure;
  readonly prepareCandidate?: (
    candidate: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>> | undefined;
}): InspectionRequestDefinition<Intent, RequestSchema> {
  const fieldNames = Object.keys(definition.schema.fields);
  const decode = Schema.decodeUnknownResult(definition.schema);
  const envelopeSchema = Schema.Struct({
    intent: Schema.Literal(definition.intent),
    request: definition.schema,
  });
  const invalidOutcome = Object.freeze(definition.invalidOutcome);
  return Object.freeze({
    intent: definition.intent,
    schema: definition.schema,
    envelopeSchema,
    invalidOutcome,
    read(value: unknown): NormalizedInspectionRequestByIntent[Intent] | undefined {
      try {
        const candidate = snapshotDataProperties(value, fieldNames);
        if (candidate === undefined) {
          return undefined;
        }
        const prepared =
          definition.prepareCandidate === undefined
            ? candidate
            : definition.prepareCandidate(candidate);
        return prepared === undefined ? undefined : Result.getOrUndefined(decode(prepared));
      } catch {
        return undefined;
      }
    },
  } satisfies InspectionRequestDefinition<Intent, RequestSchema>);
}

function prepareMemberCandidate(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const memberPath = readBoundedMemberPath(value["memberPath"]);
  return memberPath === undefined ? undefined : { ...value, memberPath };
}

function preparePlanCandidate(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const queries = readInspectionPlanQueries(value["queries"]);
  return queries.accepted ? { ...value, queries: queries.queries } : undefined;
}

function prepareComparisonCandidate(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const before = REQUEST_DEFINITIONS["interface-overview"].read(value["before"]);
  const after = REQUEST_DEFINITIONS["interface-overview"].read(value["after"]);
  return before === undefined || after === undefined ? undefined : { before, after };
}

function invalidRequest(name: string): InspectionFailure {
  return {
    status: "unsupported",
    reason: "invalid-request",
    message: `Inspection received an invalid ${name} request.`,
  };
}
