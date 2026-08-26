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
import type {
  AnalysisRequest,
  AnalysisRequestReading,
  InspectionRequestByIntent,
  InspectionFailure,
  InspectionRequestReading,
  NormalizedDeclarationInspectionRequest,
  NormalizedExportInspectionRequest,
  NormalizedExportSearchRequest,
  NormalizedInspectionPlanRequest,
  NormalizedInterfaceOverviewRequest,
  NormalizedMemberInspectionRequest,
  NormalizedPublicInterfaceComparisonRequest,
  NormalizedPublicSubpathDiscoveryRequest,
  NormalizedSignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
import {
  ANALYSIS_INTENTS,
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

export interface NormalizedInspectionRequestByIntent {
  readonly "interface-overview": NormalizedInterfaceOverviewRequest;
  readonly "export-inspection": NormalizedExportInspectionRequest;
  readonly "signature-inspection": NormalizedSignatureInspectionRequest;
  readonly "export-search": NormalizedExportSearchRequest;
  readonly "public-subpath-discovery": NormalizedPublicSubpathDiscoveryRequest;
  readonly "declaration-inspection": NormalizedDeclarationInspectionRequest;
  readonly "member-inspection": NormalizedMemberInspectionRequest;
  readonly "inspection-plan": NormalizedInspectionPlanRequest;
  readonly "public-interface-comparison": NormalizedPublicInterfaceComparisonRequest;
}

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

type InspectionRequestDefinition<Intent extends InspectionIntent> =
  InspectionRequestDescriptor<Intent> & {
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
const analysisIntentSchema = Schema.Literals(ANALYSIS_INTENTS);
const analysisRequestSchema = Schema.Union([
  Schema.Struct({ intent: Schema.Literal("interface-overview"), request: normalizedTargetSchema }),
  Schema.Struct({ intent: Schema.Literal("export-inspection"), request: normalizedExportSchema }),
  Schema.Struct({
    intent: Schema.Literal("signature-inspection"),
    request: normalizedExportSchema,
  }),
  Schema.Struct({ intent: Schema.Literal("export-search"), request: normalizedExportSearchSchema }),
  Schema.Struct({
    intent: Schema.Literal("public-subpath-discovery"),
    request: normalizedTargetSchema,
  }),
  Schema.Struct({
    intent: Schema.Literal("declaration-inspection"),
    request: normalizedExportSchema,
  }),
  Schema.Struct({ intent: Schema.Literal("member-inspection"), request: normalizedMemberSchema }),
  Schema.Struct({ intent: Schema.Literal("inspection-plan"), request: normalizedPlanSchema }),
]);
const decodeTargetCandidate = Schema.decodeUnknownResult(normalizedTargetSchema);
const decodeExportCandidate = Schema.decodeUnknownResult(normalizedExportSchema);
const decodeExportSearchCandidate = Schema.decodeUnknownResult(normalizedExportSearchSchema);
const decodeMemberCandidate = Schema.decodeUnknownResult(normalizedMemberSchema);
const decodePlanCandidate = Schema.decodeUnknownResult(normalizedPlanSchema);
const decodeComparisonCandidate = Schema.decodeUnknownResult(normalizedComparisonSchema);
const decodeAnalysisIntent = Schema.decodeUnknownResult(analysisIntentSchema);
const decodeAnalysisRequest = Schema.decodeUnknownResult(analysisRequestSchema);

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

const REQUEST_DEFINITIONS = deepFreeze({
  "interface-overview": defineRequest(
    "interface-overview",
    TARGET_FIELDS,
    { resolutionContext: "/absolute/path/to/consumer", specifier: "zod" },
    readTargetCandidate,
  ),
  "export-inspection": defineRequest(
    "export-inspection",
    [...TARGET_FIELDS, EXPORT_NAME_FIELD],
    {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
    },
    readExportCandidate,
  ),
  "signature-inspection": defineRequest(
    "signature-inspection",
    [...TARGET_FIELDS, EXPORT_NAME_FIELD],
    {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
    },
    readExportCandidate,
  ),
  "export-search": defineRequest(
    "export-search",
    [
      ...TARGET_FIELDS,
      {
        name: "query",
        kind: "string",
        required: true,
        minBytes: 1,
        maxBytes: MAX_EXPORT_SEARCH_QUERY_BYTES,
      },
    ],
    {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      query: "Error",
    },
    readExportSearchCandidate,
  ),
  "public-subpath-discovery": defineRequest(
    "public-subpath-discovery",
    TARGET_FIELDS,
    { resolutionContext: "/absolute/path/to/consumer", specifier: "zod" },
    readTargetCandidate,
  ),
  "declaration-inspection": defineRequest(
    "declaration-inspection",
    [...TARGET_FIELDS, EXPORT_NAME_FIELD],
    {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
    },
    readExportCandidate,
  ),
  "member-inspection": defineRequest(
    "member-inspection",
    [
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
    {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      exportName: "ZodError",
      memberPath: ["issues"],
    },
    readMemberCandidate,
  ),
  "inspection-plan": defineRequest(
    "inspection-plan",
    [
      ...TARGET_FIELDS,
      {
        name: "queries",
        kind: "inspection-plan-queries",
        required: true,
        minItems: 1,
        maxItems: MAX_INSPECTION_PLAN_QUERIES,
      },
    ],
    {
      resolutionContext: "/absolute/path/to/consumer",
      specifier: "zod",
      queries: [{ intent: "interface-overview" }],
    },
    readPlanCandidate,
  ),
  "public-interface-comparison": defineRequest(
    "public-interface-comparison",
    [
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
    {
      before: { resolutionContext: "/absolute/path/to/before-consumer", specifier: "zod" },
      after: { resolutionContext: "/absolute/path/to/after-consumer", specifier: "zod" },
    },
    readComparisonCandidate,
  ),
} as const satisfies {
  readonly [Intent in InspectionIntent]: InspectionRequestDefinition<Intent>;
});

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
    ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
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

function defineRequest<Intent extends InspectionIntent>(
  intent: Intent,
  fields: readonly InspectionRequestFieldDescriptor<RequestFieldName<Intent>>[],
  example: InspectionRequestByIntent[Intent],
  readCandidate: (
    candidate: Readonly<Record<string, unknown>>,
  ) => NormalizedInspectionRequestByIntent[Intent] | undefined,
): InspectionRequestDefinition<Intent> {
  const fieldNames = fields.map(({ name }) => name);
  return {
    intent,
    fields,
    example,
    read(value) {
      try {
        const candidate = snapshotDataProperties(value, fieldNames);
        return candidate === undefined ? undefined : readCandidate(candidate);
      } catch {
        return undefined;
      }
    },
  } as InspectionRequestDefinition<Intent>;
}

function readTargetCandidate(
  value: Readonly<Record<string, unknown>>,
): NormalizedInterfaceOverviewRequest | undefined {
  return Result.getOrUndefined(decodeTargetCandidate(value));
}

function readTarget(value: unknown): NormalizedInterfaceOverviewRequest | undefined {
  const candidate = snapshotDataProperties(
    value,
    TARGET_FIELDS.map(({ name }) => name),
  );
  return candidate === undefined ? undefined : readTargetCandidate(candidate);
}

function readExportCandidate(
  value: Readonly<Record<string, unknown>>,
): NormalizedExportInspectionRequest | undefined {
  return Result.getOrUndefined(decodeExportCandidate(value));
}

function readExportSearchCandidate(
  value: Readonly<Record<string, unknown>>,
): NormalizedExportSearchRequest | undefined {
  return Result.getOrUndefined(decodeExportSearchCandidate(value));
}

function readMemberCandidate(
  value: Readonly<Record<string, unknown>>,
): NormalizedMemberInspectionRequest | undefined {
  const request = readExportCandidate(value);
  const memberPath = readBoundedMemberPath(value["memberPath"]);
  return request === undefined || memberPath === undefined
    ? undefined
    : Result.getOrUndefined(decodeMemberCandidate({ ...request, memberPath }));
}

function readPlanCandidate(
  value: Readonly<Record<string, unknown>>,
): NormalizedInspectionPlanRequest | undefined {
  const request = readTargetCandidate(value);
  const queries = readInspectionPlanQueries(value["queries"]);
  return request === undefined || !queries.accepted
    ? undefined
    : Result.getOrUndefined(decodePlanCandidate({ ...request, queries: queries.queries }));
}

function readComparisonCandidate(
  value: Readonly<Record<string, unknown>>,
): NormalizedPublicInterfaceComparisonRequest | undefined {
  const before = readTarget(value["before"]);
  const after = readTarget(value["after"]);
  return before === undefined || after === undefined
    ? undefined
    : Result.getOrUndefined(decodeComparisonCandidate({ before, after }));
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
