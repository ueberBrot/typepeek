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
import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

export type RequestFieldName<Intent extends InspectionIntent> = Extract<
  keyof InspectionRequestByIntent[Intent],
  string
>;

export type InspectionRequestFieldDescriptor<Name extends string = string> =
  | {
      readonly name: Name;
      readonly kind: "string";
      readonly required: boolean;
      readonly format?: "absolute-path";
      readonly minBytes?: number;
      readonly maxBytes?: number;
    }
  | {
      readonly name: Name;
      readonly kind: "enum";
      readonly required: boolean;
      readonly values: readonly string[];
      readonly default?: string;
    }
  | {
      readonly name: Name;
      readonly kind: "inspection-plan-queries" | "member-path";
      readonly required: boolean;
      readonly minItems: number;
      readonly maxItems: number;
      readonly maxItemBytes?: number;
    }
  | {
      readonly name: Name;
      readonly kind: "inspection-target";
      readonly required: true;
      readonly resolutionContextFormat: "absolute-path";
    };

export type InspectionRequestDescriptor<Intent extends InspectionIntent = InspectionIntent> = {
  readonly [CurrentIntent in Intent]: {
    readonly intent: CurrentIntent;
    readonly fields: readonly InspectionRequestFieldDescriptor<RequestFieldName<CurrentIntent>>[];
    readonly example: InspectionRequestByIntent[CurrentIntent];
  };
}[Intent];

type InspectionRequestDefinition<
  Intent extends InspectionIntent,
  RequestSchema extends Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]> =
    Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]>,
> = InspectionRequestDescriptor<Intent> & {
  readonly schema: RequestSchema;
  readonly envelopeSchema: Schema.Struct<{
    readonly intent: Schema.Literal<Intent>;
    readonly request: RequestSchema;
  }>;
  readonly invalidOutcome: InspectionFailure;
  readonly read: (value: unknown) => NormalizedInspectionRequestByIntent[Intent] | undefined;
};

const TARGET_FIELDS = [
  {
    name: "resolutionContext",
    kind: "string",
    required: true,
    format: "absolute-path",
  },
  { name: "specifier", kind: "string", required: true },
  {
    name: "accessStyle",
    kind: "enum",
    required: false,
    values: ["import", "require"],
    default: "import",
  },
] as const;
const EXPORT_NAME_FIELD = { name: "exportName", kind: "string", required: true } as const;

const accessStyleSchema = Schema.Literals(["import", "require"]);
const normalizedTargetFields = {
  resolutionContext: Schema.String.check(
    Schema.makeFilter(isAbsolute, { expected: "an absolute path" }),
  ),
  specifier: Schema.String,
  accessStyle: accessStyleSchema.pipe(Schema.withDecodingDefault(Effect.succeed("import"))),
} as const;
const normalizedTargetSchema = Schema.Struct(normalizedTargetFields);
const normalizedExportSchema = Schema.Struct({
  ...normalizedTargetFields,
  exportName: Schema.String,
});
const normalizedExportSearchSchema = Schema.Struct({
  ...normalizedTargetFields,
  query: Schema.String.check(
    Schema.makeFilter(isBoundedExportSearchQuery, { expected: "a bounded search query" }),
  ),
});
const normalizedMemberSchema = Schema.Struct({
  ...normalizedTargetFields,
  exportName: Schema.String,
  memberPath: memberPathSchema,
});
const normalizedPlanSchema = Schema.Struct({
  ...normalizedTargetFields,
  queries: inspectionPlanQueriesSchema,
});
const normalizedComparisonSchema = Schema.Struct({
  before: normalizedTargetSchema,
  after: normalizedTargetSchema,
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
    fields: TARGET_FIELDS,
    example: { resolutionContext: "/absolute/path/to/consumer", specifier: "zod" },
  }),
  "export-inspection": defineRequest({
    intent: "export-inspection",
    schema: inspectionRequestSchemas["export-inspection"],
    invalidOutcome: invalidRequest("Export Inspection"),
    fields: [...TARGET_FIELDS, EXPORT_NAME_FIELD],
    example: {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
    },
  }),
  "signature-inspection": defineRequest({
    intent: "signature-inspection",
    schema: inspectionRequestSchemas["signature-inspection"],
    invalidOutcome: invalidRequest("Signature Inspection"),
    fields: [...TARGET_FIELDS, EXPORT_NAME_FIELD],
    example: {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
    },
  }),
  "export-search": defineRequest({
    intent: "export-search",
    schema: inspectionRequestSchemas["export-search"],
    invalidOutcome: invalidRequest("Export Search"),
    fields: [
      ...TARGET_FIELDS,
      {
        name: "query",
        kind: "string",
        required: true,
        minBytes: 1,
        maxBytes: MAX_EXPORT_SEARCH_QUERY_BYTES,
      },
    ],
    example: {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      query: "Error",
    },
  }),
  "public-subpath-discovery": defineRequest({
    intent: "public-subpath-discovery",
    schema: inspectionRequestSchemas["public-subpath-discovery"],
    invalidOutcome: invalidRequest("Public Subpath Discovery"),
    fields: TARGET_FIELDS,
    example: { resolutionContext: "/absolute/path/to/consumer", specifier: "zod" },
  }),
  "declaration-inspection": defineRequest({
    intent: "declaration-inspection",
    schema: inspectionRequestSchemas["declaration-inspection"],
    invalidOutcome: invalidRequest("Declaration Inspection"),
    fields: [...TARGET_FIELDS, EXPORT_NAME_FIELD],
    example: {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
    },
  }),
  "member-inspection": defineRequest({
    intent: "member-inspection",
    schema: inspectionRequestSchemas["member-inspection"],
    invalidOutcome: invalidRequest("Member Inspection"),
    fields: [
      ...TARGET_FIELDS,
      EXPORT_NAME_FIELD,
      {
        name: "memberPath",
        kind: "member-path",
        required: true,
        minItems: 1,
        maxItems: MAX_MEMBER_PATH_SEGMENTS,
        maxItemBytes: MAX_MEMBER_PATH_SEGMENT_BYTES,
      },
    ],
    example: {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
      memberPath: ["issues"],
    },
    prepareCandidate: prepareMemberCandidate,
  }),
  "inspection-plan": defineRequest({
    intent: "inspection-plan",
    schema: inspectionRequestSchemas["inspection-plan"],
    invalidOutcome: invalidRequest("Inspection Plan"),
    fields: [
      ...TARGET_FIELDS,
      {
        name: "queries",
        kind: "inspection-plan-queries",
        required: true,
        minItems: 1,
        maxItems: MAX_INSPECTION_PLAN_QUERIES,
      },
    ],
    example: {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      queries: [{ intent: "interface-overview" }],
    },
    prepareCandidate: preparePlanCandidate,
  }),
  "public-interface-comparison": defineRequest({
    intent: "public-interface-comparison",
    schema: inspectionRequestSchemas["public-interface-comparison"],
    invalidOutcome: invalidRequest("Public Interface Comparison"),
    fields: [
      {
        name: "before",
        kind: "inspection-target",
        required: true,
        resolutionContextFormat: "absolute-path",
      },
      {
        name: "after",
        kind: "inspection-target",
        required: true,
        resolutionContextFormat: "absolute-path",
      },
    ],
    example: {
      before: { resolutionContext: "/absolute/path/to/before-consumer", specifier: "zod" },
      after: { resolutionContext: "/absolute/path/to/after-consumer", specifier: "zod" },
    },
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

export const INSPECTION_REQUEST_DESCRIPTORS = deepFreeze(
  Object.values(REQUEST_DEFINITIONS).map(({ intent, fields, example }) => ({
    intent,
    fields,
    example,
  })),
) as readonly InspectionRequestDescriptor[];

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
  RequestSchema extends Schema.ConstraintDecoder<NormalizedInspectionRequestByIntent[Intent]>,
>(definition: {
  readonly intent: Intent;
  readonly schema: RequestSchema;
  readonly invalidOutcome: InspectionFailure;
  readonly fields: readonly InspectionRequestFieldDescriptor<RequestFieldName<Intent>>[];
  readonly example: InspectionRequestByIntent[Intent];
  readonly prepareCandidate?: (
    candidate: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>> | undefined;
}): InspectionRequestDefinition<Intent, RequestSchema> {
  const fieldNames = definition.fields.map(({ name }) => name);
  const decode = Schema.decodeUnknownResult(definition.schema);
  const envelopeSchema = Schema.Struct({
    intent: Schema.Literal(definition.intent),
    request: definition.schema,
  });
  deepFreeze(definition.invalidOutcome);
  deepFreeze(definition.fields);
  deepFreeze(definition.example);
  return Object.freeze({
    intent: definition.intent,
    schema: definition.schema,
    envelopeSchema,
    invalidOutcome: definition.invalidOutcome,
    fields: definition.fields,
    example: definition.example,
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

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function invalidRequest(name: string): InspectionFailure {
  return {
    status: "unsupported",
    reason: "invalid-request",
    message: `Inspection received an invalid ${name} request.`,
  };
}
