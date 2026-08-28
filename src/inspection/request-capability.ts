import { Result, Schema } from "effect";

import { inspectionIntentSchema } from "#typepeek/inspection/protocol-vocabulary";

const MAX_CAPABILITY_FIELD_NAME_BYTES = 64;
const MAX_CAPABILITY_FIELDS = 8;

const capabilityFieldNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((name) => Buffer.byteLength(name) <= MAX_CAPABILITY_FIELD_NAME_BYTES, {
    expected: "a bounded capability field name",
  }),
);
const positiveNaturalSchema = Schema.Natural.check(Schema.isGreaterThan(0));
const stringFieldCapabilityFields = {
  kind: Schema.Literal("string"),
  format: Schema.optionalKey(Schema.Literal("absolute-path")),
  minBytes: Schema.optionalKey(Schema.Natural),
  maxBytes: Schema.optionalKey(positiveNaturalSchema),
} as const;
const enumFieldCapabilityFields = {
  kind: Schema.Literal("enum"),
  values: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.isUnique(),
  ),
  default: Schema.optionalKey(Schema.String),
} as const;
const collectionFieldCapabilityFields = {
  kind: Schema.Literals(["inspection-plan-queries", "member-path"]),
  minItems: Schema.Natural,
  maxItems: positiveNaturalSchema,
  maxItemBytes: Schema.optionalKey(positiveNaturalSchema),
} as const;

const stringFieldCapabilityStruct = Schema.Struct(stringFieldCapabilityFields);
const enumFieldCapabilityStruct = Schema.Struct(enumFieldCapabilityFields);
const collectionFieldCapabilityStruct = Schema.Struct(collectionFieldCapabilityFields);
const stringFieldCapabilitySchema = stringFieldCapabilityStruct.check(
  Schema.makeFilter(({ minBytes, maxBytes }: typeof stringFieldCapabilityStruct.Type) =>
    minBytes === undefined || maxBytes === undefined || minBytes <= maxBytes
      ? undefined
      : { path: ["minBytes"], issue: "minBytes must not exceed maxBytes" },
  ),
);
const enumFieldCapabilitySchema = enumFieldCapabilityStruct.check(
  Schema.makeFilter(({ default: defaultValue, values }: typeof enumFieldCapabilityStruct.Type) =>
    defaultValue === undefined || values.includes(defaultValue)
      ? undefined
      : { path: ["default"], issue: "default must be one of values" },
  ),
);
const collectionFieldCapabilitySchema = collectionFieldCapabilityStruct.check(
  Schema.makeFilter(({ minItems, maxItems }: typeof collectionFieldCapabilityStruct.Type) =>
    minItems <= maxItems
      ? undefined
      : { path: ["minItems"], issue: "minItems must not exceed maxItems" },
  ),
);
const inspectionTargetFieldCapabilitySchema = Schema.Struct({
  kind: Schema.Literal("inspection-target"),
  resolutionContextFormat: Schema.Literal("absolute-path"),
});

const inspectionRequestFieldCapabilitySchema = Schema.Union([
  stringFieldCapabilitySchema,
  enumFieldCapabilitySchema,
  collectionFieldCapabilitySchema,
  inspectionTargetFieldCapabilitySchema,
]);
export type InspectionRequestFieldCapability = typeof inspectionRequestFieldCapabilitySchema.Type;
const isInspectionRequestFieldCapability = Schema.is(inspectionRequestFieldCapabilitySchema);

const requestFieldDescriptorSchema = <FieldNameSchema extends Schema.ConstraintDecoder<string>>(
  fieldNameSchema: FieldNameSchema,
) => {
  const stringDescriptorStruct = Schema.Struct({
    name: fieldNameSchema,
    required: Schema.Boolean,
    ...stringFieldCapabilityFields,
  });
  const enumDescriptorStruct = Schema.Struct({
    name: fieldNameSchema,
    required: Schema.Boolean,
    ...enumFieldCapabilityFields,
  });
  const collectionDescriptorStruct = Schema.Struct({
    name: fieldNameSchema,
    required: Schema.Boolean,
    ...collectionFieldCapabilityFields,
  });

  return Schema.Union([
    stringDescriptorStruct,
    enumDescriptorStruct,
    collectionDescriptorStruct,
    Schema.Struct({
      name: fieldNameSchema,
      required: Schema.Literal(true),
      ...inspectionTargetFieldCapabilitySchema.fields,
    }),
  ]).check(
    Schema.makeFilter(isInspectionRequestFieldCapability, {
      expected: "valid request field capability metadata",
    }),
  );
};

export type InspectionRequestFieldDescriptorFor<Name extends string> = ReturnType<
  typeof requestFieldDescriptorSchema<Schema.Literal<Name>>
>["Type"];

const inspectionRequestFieldDescriptorSchema =
  requestFieldDescriptorSchema(capabilityFieldNameSchema);
const inspectionRequestDescriptorSchema = Schema.Struct({
  intent: inspectionIntentSchema,
  fields: Schema.Array(inspectionRequestFieldDescriptorSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CAPABILITY_FIELDS),
  ),
  example: Schema.Json,
});

export type SchemaDerivedRequestDescriptor = typeof inspectionRequestDescriptorSchema.Type;

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly inspectionRequestField?: InspectionRequestFieldCapability | undefined;
      readonly inspectionRequestExample?: typeof Schema.Json.Type | undefined;
    }
  }
}

/** Attaches agent-facing field semantics to the executable request field schema. */
export function withRequestFieldCapability<SchemaType extends Schema.Top>(
  schema: SchemaType,
  capability: InspectionRequestFieldCapability,
): SchemaType["Rebuild"] {
  const validated = Schema.decodeSync(inspectionRequestFieldCapabilitySchema)(capability);
  return schema.annotate({ inspectionRequestField: validated });
}

/** Narrows descriptor field names to the keys of one executable request schema. */
export function inspectionRequestFieldDescriptorFor<
  FieldNameSchema extends Schema.ConstraintDecoder<string>,
>(fieldNameSchema: FieldNameSchema) {
  return requestFieldDescriptorSchema(fieldNameSchema);
}

/** Derives one compact capability descriptor from an executable request schema. */
export function deriveInspectionRequestDescriptor<
  Intent extends typeof inspectionIntentSchema.Type,
>(
  intent: Intent,
  schema: Schema.Struct<Schema.Struct.Fields> & Schema.ConstraintDecoder<unknown>,
): SchemaDerivedRequestDescriptor {
  const requiredNames = requiredPropertyNames(schema);
  const fields = Object.entries(schema.fields).map(([name, field]) => {
    const capability = Schema.resolveAnnotations(field)?.inspectionRequestField;
    if (capability === undefined) {
      throw new Error(`Request field "${name}" is missing capability metadata.`);
    }
    return Schema.decodeUnknownSync(inspectionRequestFieldDescriptorSchema)({
      name,
      required: requiredNames.has(name),
      ...capability,
    });
  });
  const example = Schema.resolveAnnotations(schema)?.inspectionRequestExample;
  if (example === undefined || Result.isFailure(Schema.decodeUnknownResult(schema)(example))) {
    throw new Error(`Request schema "${intent}" must declare one valid encoded example.`);
  }
  return Schema.decodeUnknownSync(inspectionRequestDescriptorSchema)({ intent, fields, example });
}

function requiredPropertyNames(schema: Schema.Struct<Schema.Struct.Fields>): ReadonlySet<string> {
  const root = Schema.toJsonSchemaDocument(schema).schema;
  const required = root["required"];
  if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
    throw new Error("Request schema did not produce a required-property list.");
  }
  return new Set(required);
}
