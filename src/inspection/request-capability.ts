import { Predicate, Result, Schema } from "effect";

import { inspectionIntentSchema } from "#typepeek/inspection/protocol-vocabulary";

const MAX_CAPABILITY_FIELD_NAME_BYTES = 64;
const MAX_CAPABILITY_FIELDS = 8;

const capabilityFieldNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((name) => Buffer.byteLength(name) <= MAX_CAPABILITY_FIELD_NAME_BYTES, {
    expected: "a bounded capability field name",
  }),
);
const stringFieldCapabilityFields = {
  kind: Schema.Literal("string"),
  format: Schema.optionalKey(Schema.Literal("absolute-path")),
  minBytes: Schema.optionalKey(Schema.Natural),
  maxBytes: Schema.optionalKey(Schema.Natural),
} as const;
const enumFieldCapabilityFields = {
  kind: Schema.Literal("enum"),
  values: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  default: Schema.optionalKey(Schema.String),
} as const;
const collectionFieldCapabilityFields = {
  kind: Schema.Literals(["inspection-plan-queries", "member-path"]),
  minItems: Schema.Natural,
  maxItems: Schema.Natural,
  maxItemBytes: Schema.optionalKey(Schema.Natural),
} as const;
const stringFieldCapabilitySchema = Schema.Struct(stringFieldCapabilityFields).check(
  Schema.makeFilter(hasValidCapabilityRelationships, {
    expected: "consistent string byte bounds",
  }),
);
const enumFieldCapabilitySchema = Schema.Struct(enumFieldCapabilityFields).check(
  Schema.makeFilter(hasValidCapabilityRelationships, {
    expected: "an enum default included in its values",
  }),
);
const collectionFieldCapabilitySchema = Schema.Struct(collectionFieldCapabilityFields).check(
  Schema.makeFilter(hasValidCapabilityRelationships, {
    expected: "consistent collection bounds",
  }),
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

const requestFieldDescriptorSchema = <FieldNameSchema extends Schema.ConstraintDecoder<string>>(
  fieldNameSchema: FieldNameSchema,
) =>
  Schema.Union([
    Schema.Struct({
      name: fieldNameSchema,
      required: Schema.Boolean,
      ...stringFieldCapabilityFields,
    }),
    Schema.Struct({
      name: fieldNameSchema,
      required: Schema.Boolean,
      ...enumFieldCapabilityFields,
    }),
    Schema.Struct({
      name: fieldNameSchema,
      required: Schema.Boolean,
      ...collectionFieldCapabilityFields,
    }),
    Schema.Struct({
      name: fieldNameSchema,
      required: Schema.Literal(true),
      ...inspectionTargetFieldCapabilitySchema.fields,
    }),
  ]).check(
    Schema.makeFilter((descriptor) => hasValidCapabilityRelationships(descriptor), {
      expected: "consistent request field capability metadata",
    }),
  );

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

function hasValidCapabilityRelationships(value: unknown): boolean {
  if (!Predicate.isObject(value)) {
    return false;
  }
  switch (value["kind"]) {
    case "string":
      if (
        (value["minBytes"] !== undefined && typeof value["minBytes"] !== "number") ||
        (value["maxBytes"] !== undefined && typeof value["maxBytes"] !== "number")
      ) {
        return false;
      }
      return (
        (value["maxBytes"] === undefined || value["maxBytes"] > 0) &&
        (value["minBytes"] === undefined ||
          value["maxBytes"] === undefined ||
          value["minBytes"] <= value["maxBytes"])
      );
    case "enum": {
      const values = value["values"];
      const defaultValue = value["default"];
      if (
        !Array.isArray(values) ||
        !values.every((entry) => typeof entry === "string") ||
        (defaultValue !== undefined && typeof defaultValue !== "string")
      ) {
        return false;
      }
      return (
        new Set(values).size === values.length &&
        (defaultValue === undefined || values.includes(defaultValue))
      );
    }
    case "inspection-plan-queries":
    case "member-path": {
      const minItems = value["minItems"];
      const maxItems = value["maxItems"];
      const maxItemBytes = value["maxItemBytes"];
      if (
        typeof minItems !== "number" ||
        typeof maxItems !== "number" ||
        (maxItemBytes !== undefined && typeof maxItemBytes !== "number")
      ) {
        return false;
      }
      return (
        maxItems > 0 && minItems <= maxItems && (maxItemBytes === undefined || maxItemBytes > 0)
      );
    }
    case "inspection-target":
      return true;
    default:
      return false;
  }
}
