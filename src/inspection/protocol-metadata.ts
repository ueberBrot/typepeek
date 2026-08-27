import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";

import {
  INSPECTION_BUDGET_DIMENSIONS,
  INSPECTION_FAILURE_REASONS,
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  SIGNATURE_EVIDENCE_INTENTS,
  inspectionIntentSchema,
  signatureEvidenceKindSchema,
  type InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  type InspectionRequestFieldDescriptorFor,
  inspectionRequestFieldDescriptorFor,
} from "#typepeek/inspection/request-capability";
import {
  INSPECTION_REQUEST_DESCRIPTORS,
  inspectionRequestFieldNames,
  inspectionRequestSchemas,
} from "#typepeek/inspection/request-definitions";

export {
  INSPECTION_BUDGET_DIMENSIONS,
  INSPECTION_FAILURE_REASONS,
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
} from "#typepeek/inspection/protocol-vocabulary";
export type {
  InspectionBudgetDimension,
  InspectionFailureReason,
  InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";

const MAX_INSPECTION_CAPABILITIES_BYTES = 16_384 as const;

type LiteralSchemas<Values extends readonly string[]> = {
  readonly [Index in keyof Values]: Schema.Literal<Values[Index]>;
};

function literalTupleSchema<const Values extends readonly string[]>(values: Values) {
  const elements = values.map((value) =>
    Schema.Literal(value),
  ) as unknown as LiteralSchemas<Values>;
  return Schema.Tuple(elements);
}

function requestDescriptorFor(intent: InspectionIntent) {
  const descriptor = INSPECTION_REQUEST_DESCRIPTORS.find(
    (candidate) => candidate.intent === intent,
  );
  if (descriptor === undefined) {
    throw new Error(`Request schema "${intent}" is missing its derived descriptor.`);
  }
  return descriptor;
}

function requestDescriptorSchema<
  const Intent extends InspectionIntent,
  RequestSchema extends Schema.Struct<Schema.Struct.Fields>,
  const FieldNames extends readonly Extract<keyof RequestSchema["fields"], string>[],
>(intent: Intent, requestSchema: RequestSchema, fieldNames: FieldNames) {
  const expected = requestDescriptorFor(intent);
  if (!isDeepStrictEqual(fieldNames, Object.keys(requestSchema.fields))) {
    throw new Error(`Request schema "${intent}" has inconsistent ordered field metadata.`);
  }
  const descriptorSchema = Schema.Struct({
    intent: Schema.Literal(intent),
    fields: requestFieldDescriptorTuple(fieldNames).check(
      Schema.makeFilter((fields) => isDeepStrictEqual(fields, expected.fields), {
        expected: `the schema-derived ${intent} field descriptors`,
      }),
    ),
    example: Schema.toEncoded(requestSchema),
  });
  return descriptorSchema.check(
    Schema.makeFilter((descriptor) => isDeepStrictEqual(descriptor, expected), {
      expected: `the canonical ${intent} request descriptor`,
    }),
  );
}

type FieldDescriptorSchemas<FieldNames extends readonly string[]> = {
  readonly [Index in keyof FieldNames]: Schema.Codec<
    InspectionRequestFieldDescriptorFor<FieldNames[Index]>
  >;
};

function requestFieldDescriptorTuple<const FieldNames extends readonly string[]>(
  fieldNames: FieldNames,
) {
  const elements = fieldNames.map((name) =>
    inspectionRequestFieldDescriptorFor(Schema.Literal(name)),
  ) as unknown as FieldDescriptorSchemas<FieldNames>;
  return Schema.Tuple(elements);
}

const requestDescriptorsSchema = Schema.Tuple([
  requestDescriptorSchema(
    "interface-overview",
    inspectionRequestSchemas["interface-overview"],
    inspectionRequestFieldNames["interface-overview"],
  ),
  requestDescriptorSchema(
    "export-inspection",
    inspectionRequestSchemas["export-inspection"],
    inspectionRequestFieldNames["export-inspection"],
  ),
  requestDescriptorSchema(
    "signature-inspection",
    inspectionRequestSchemas["signature-inspection"],
    inspectionRequestFieldNames["signature-inspection"],
  ),
  requestDescriptorSchema(
    "export-search",
    inspectionRequestSchemas["export-search"],
    inspectionRequestFieldNames["export-search"],
  ),
  requestDescriptorSchema(
    "public-subpath-discovery",
    inspectionRequestSchemas["public-subpath-discovery"],
    inspectionRequestFieldNames["public-subpath-discovery"],
  ),
  requestDescriptorSchema(
    "declaration-inspection",
    inspectionRequestSchemas["declaration-inspection"],
    inspectionRequestFieldNames["declaration-inspection"],
  ),
  requestDescriptorSchema(
    "member-inspection",
    inspectionRequestSchemas["member-inspection"],
    inspectionRequestFieldNames["member-inspection"],
  ),
  requestDescriptorSchema(
    "inspection-plan",
    inspectionRequestSchemas["inspection-plan"],
    inspectionRequestFieldNames["inspection-plan"],
  ),
  requestDescriptorSchema(
    "public-interface-comparison",
    inspectionRequestSchemas["public-interface-comparison"],
    inspectionRequestFieldNames["public-interface-comparison"],
  ),
]);
const responseOptionSchema = Schema.Struct({
  name: Schema.Literal("signatureEvidence"),
  appliesTo: literalTupleSchema(SIGNATURE_EVIDENCE_INTENTS),
  values: literalTupleSchema(signatureEvidenceKindSchema.literals),
  default: Schema.Literal("structured"),
});
const inspectionCapabilitiesBaseSchema = Schema.Struct({
  intent: Schema.Literal("capabilities"),
  protocolVersion: Schema.Literal(INSPECTION_PROTOCOL_VERSION),
  supportedProtocolVersions: Schema.Tuple([Schema.Literal(INSPECTION_PROTOCOL_VERSION)]),
  supportedIntents: literalTupleSchema(inspectionIntentSchema.literals),
  failureReasons: literalTupleSchema(INSPECTION_FAILURE_REASONS),
  budgetDimensions: literalTupleSchema(INSPECTION_BUDGET_DIMENSIONS),
  requestDescriptors: requestDescriptorsSchema,
  responseOptions: Schema.Tuple([responseOptionSchema]),
  limits: Schema.Struct({
    maxSerializedBytes: Schema.Literal(MAX_INSPECTION_CAPABILITIES_BYTES),
  }),
});

export const inspectionCapabilitiesSchema = inspectionCapabilitiesBaseSchema.check(
  Schema.makeFilter(hasBoundedSerializedSize, {
    expected: `capabilities serialized within ${MAX_INSPECTION_CAPABILITIES_BYTES} bytes`,
  }),
);
export type InspectionCapabilities = typeof inspectionCapabilitiesSchema.Type;
export type InspectionRequestDescriptor = InspectionCapabilities["requestDescriptors"][number];
export type InspectionRequestFieldDescriptor = InspectionRequestDescriptor["fields"][number];

const REQUEST_DESCRIPTORS = Schema.decodeUnknownSync(requestDescriptorsSchema)(
  INSPECTION_REQUEST_DESCRIPTORS,
);
const CAPABILITIES = deepFreeze(
  Schema.decodeSync(inspectionCapabilitiesSchema)({
    intent: "capabilities",
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    supportedProtocolVersions: [INSPECTION_PROTOCOL_VERSION],
    supportedIntents: INSPECTION_INTENTS,
    failureReasons: INSPECTION_FAILURE_REASONS,
    budgetDimensions: INSPECTION_BUDGET_DIMENSIONS,
    requestDescriptors: REQUEST_DESCRIPTORS,
    responseOptions: [
      {
        name: "signatureEvidence",
        appliesTo: SIGNATURE_EVIDENCE_INTENTS,
        values: signatureEvidenceKindSchema.literals,
        default: "structured",
      },
    ],
    limits: { maxSerializedBytes: MAX_INSPECTION_CAPABILITIES_BYTES },
  }),
);

/** Describes the bounded stable protocol vocabulary available to any adapter. */
export function inspectCapabilities(): InspectionCapabilities {
  return CAPABILITIES;
}

function hasBoundedSerializedSize(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_INSPECTION_CAPABILITIES_BYTES;
  } catch {
    return false;
  }
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
