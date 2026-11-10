import { isDeepStrictEqual } from "node:util";

import { Predicate, Schema } from "effect";

import type { InspectionIntent } from "#typepeek/inspection/model/protocol-vocabulary";
import {
  INSPECTION_BUDGET_DIMENSIONS,
  INSPECTION_FAILURE_REASONS,
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  PROTOCOL_RECOVERY_POLICY,
  PROTOCOL_RECOVERY_REASONS,
  SIGNATURE_EVIDENCE_INTENTS,
  inspectionIntentSchema,
  protocolRecoveryPolicySchema,
  signatureEvidenceKindSchema,
} from "#typepeek/inspection/model/protocol-vocabulary";
import type { InspectionRequestFieldDescriptorFor } from "#typepeek/inspection/model/request-capability";
import { inspectionRequestFieldDescriptorFor } from "#typepeek/inspection/model/request-capability";
import {
  INSPECTION_REQUEST_DESCRIPTORS,
  inspectionRequestFieldNames,
  inspectionRequestSchemas,
} from "#typepeek/inspection/model/request-definitions";

export {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
} from "#typepeek/inspection/model/protocol-vocabulary";

export type { InspectionIntent } from "#typepeek/inspection/model/protocol-vocabulary";

const MAX_INSPECTION_CAPABILITIES_BYTES = 16_384 as const;

type LiteralSchemas<Values extends readonly string[]> = {
  readonly [Index in keyof Values]: Schema.Literal<Values[Index]>;
};

const literalTupleSchema = function literalTupleSchema<
  const Values extends readonly string[],
>(values: Values) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Each input position becomes its own literal schema; Array.map preserves the tuple's order and length.
  const elements = values.map((value) =>
    Schema.Literal(value)
  ) as LiteralSchemas<Values>;

  return Schema.Tuple(elements);
};

const requestDescriptorFor = function requestDescriptorFor(
  intent: InspectionIntent
) {
  const descriptor = INSPECTION_REQUEST_DESCRIPTORS.find(
    (candidate) => candidate.intent === intent
  );

  if (descriptor === undefined) {
    throw new Error(
      `Request schema "${intent}" is missing its derived descriptor.`
    );
  }

  return descriptor;
};

const requestFieldDescriptorTuple = function requestFieldDescriptorTuple<
  const FieldNames extends readonly string[],
>(fieldNames: FieldNames) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Every name is mapped to its corresponding field descriptor schema without reordering or dropping entries.
  const elements = fieldNames.map((name) =>
    inspectionRequestFieldDescriptorFor(Schema.Literal(name))
  ) as FieldDescriptorSchemas<FieldNames>;

  return Schema.Tuple(elements);
};

const requestDescriptorSchema = function requestDescriptorSchema<
  const Intent extends InspectionIntent,
  RequestSchema extends Schema.Struct<Schema.Struct.Fields>,
  const FieldNames extends readonly Extract<
    keyof RequestSchema["fields"],
    string
  >[],
>(intent: Intent, requestSchema: RequestSchema, fieldNames: FieldNames) {
  const expected = requestDescriptorFor(intent);

  if (!isDeepStrictEqual(fieldNames, Object.keys(requestSchema.fields))) {
    throw new Error(
      `Request schema "${intent}" has inconsistent ordered field metadata.`
    );
  }

  const descriptorSchema = Schema.Struct({
    example: Schema.toEncoded(requestSchema),
    fields: requestFieldDescriptorTuple(fieldNames).check(
      Schema.makeFilter(
        (fields) => isDeepStrictEqual(fields, expected.fields),
        {
          expected: `the schema-derived ${intent} field descriptors`,
        }
      )
    ),
    intent: Schema.Literal(intent),
  });

  return descriptorSchema.check(
    Schema.makeFilter((descriptor) => isDeepStrictEqual(descriptor, expected), {
      expected: `the canonical ${intent} request descriptor`,
    })
  );
};

type FieldDescriptorSchemas<FieldNames extends readonly string[]> = {
  readonly [Index in keyof FieldNames]: Schema.Codec<
    InspectionRequestFieldDescriptorFor<FieldNames[Index]>
  >;
};

const requestDescriptorsSchema = Schema.Tuple([
  requestDescriptorSchema(
    "interface-overview",
    inspectionRequestSchemas["interface-overview"],
    inspectionRequestFieldNames["interface-overview"]
  ),
  requestDescriptorSchema(
    "export-inspection",
    inspectionRequestSchemas["export-inspection"],
    inspectionRequestFieldNames["export-inspection"]
  ),
  requestDescriptorSchema(
    "signature-inspection",
    inspectionRequestSchemas["signature-inspection"],
    inspectionRequestFieldNames["signature-inspection"]
  ),
  requestDescriptorSchema(
    "export-search",
    inspectionRequestSchemas["export-search"],
    inspectionRequestFieldNames["export-search"]
  ),
  requestDescriptorSchema(
    "public-subpath-discovery",
    inspectionRequestSchemas["public-subpath-discovery"],
    inspectionRequestFieldNames["public-subpath-discovery"]
  ),
  requestDescriptorSchema(
    "declaration-inspection",
    inspectionRequestSchemas["declaration-inspection"],
    inspectionRequestFieldNames["declaration-inspection"]
  ),
  requestDescriptorSchema(
    "member-inspection",
    inspectionRequestSchemas["member-inspection"],
    inspectionRequestFieldNames["member-inspection"]
  ),
  requestDescriptorSchema(
    "member-discovery",
    inspectionRequestSchemas["member-discovery"],
    inspectionRequestFieldNames["member-discovery"]
  ),
  requestDescriptorSchema(
    "inspection-plan",
    inspectionRequestSchemas["inspection-plan"],
    inspectionRequestFieldNames["inspection-plan"]
  ),
  requestDescriptorSchema(
    "public-interface-comparison",
    inspectionRequestSchemas["public-interface-comparison"],
    inspectionRequestFieldNames["public-interface-comparison"]
  ),
]);

const responseOptionSchema = Schema.Struct({
  appliesTo: literalTupleSchema(SIGNATURE_EVIDENCE_INTENTS),
  default: Schema.Literal("structured"),
  name: Schema.Literal("signatureEvidence"),
  values: literalTupleSchema(signatureEvidenceKindSchema.literals),
});

const inspectionCapabilitiesBaseSchema = Schema.Struct({
  budgetDimensions: literalTupleSchema(INSPECTION_BUDGET_DIMENSIONS),
  failureReasons: literalTupleSchema(INSPECTION_FAILURE_REASONS),
  intent: Schema.Literal("capabilities"),
  limits: Schema.Struct({
    maxRecoveryBytes: protocolRecoveryPolicySchema.fields.maximumBytes,
    maxRecoveryEntries: protocolRecoveryPolicySchema.fields.maximumEntries,
    maxSerializedBytes: Schema.Literal(MAX_INSPECTION_CAPABILITIES_BYTES),
  }),
  protocolVersion: Schema.Literal(INSPECTION_PROTOCOL_VERSION),
  recoveryReasons: literalTupleSchema(PROTOCOL_RECOVERY_REASONS),
  requestDescriptors: requestDescriptorsSchema,
  responseOptions: Schema.Tuple([responseOptionSchema]),
  supportedIntents: literalTupleSchema(inspectionIntentSchema.literals),
  supportedProtocolVersions: Schema.Tuple([
    Schema.Literal(INSPECTION_PROTOCOL_VERSION),
  ]),
});

const hasBoundedSerializedSize = function hasBoundedSerializedSize(
  value: typeof inspectionCapabilitiesBaseSchema.Type
): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(value)) <=
      MAX_INSPECTION_CAPABILITIES_BYTES
    );
  } catch {
    return false;
  }
};

export const inspectionCapabilitiesSchema =
  inspectionCapabilitiesBaseSchema.check(
    Schema.makeFilter(hasBoundedSerializedSize, {
      expected: `capabilities serialized within ${MAX_INSPECTION_CAPABILITIES_BYTES} bytes`,
    })
  );

export type InspectionCapabilities = typeof inspectionCapabilitiesSchema.Type;

const REQUEST_DESCRIPTORS = Schema.decodeUnknownSync(requestDescriptorsSchema)(
  INSPECTION_REQUEST_DESCRIPTORS
);

const deepFreeze = function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (!Predicate.isObjectOrArray(value) || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
};

const CAPABILITIES = deepFreeze(
  Schema.decodeSync(inspectionCapabilitiesSchema)({
    budgetDimensions: INSPECTION_BUDGET_DIMENSIONS,
    failureReasons: INSPECTION_FAILURE_REASONS,
    intent: "capabilities",
    limits: {
      maxRecoveryBytes: PROTOCOL_RECOVERY_POLICY.maximumBytes,
      maxRecoveryEntries: PROTOCOL_RECOVERY_POLICY.maximumEntries,
      maxSerializedBytes: MAX_INSPECTION_CAPABILITIES_BYTES,
    },
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    recoveryReasons: PROTOCOL_RECOVERY_REASONS,
    requestDescriptors: REQUEST_DESCRIPTORS,
    responseOptions: [
      {
        appliesTo: SIGNATURE_EVIDENCE_INTENTS,
        default: "structured",
        name: "signatureEvidence",
        values: signatureEvidenceKindSchema.literals,
      },
    ],
    supportedIntents: INSPECTION_INTENTS,
    supportedProtocolVersions: [INSPECTION_PROTOCOL_VERSION],
  })
);

export const inspectCapabilities =
  function inspectCapabilities(): InspectionCapabilities {
    return CAPABILITIES;
  };
