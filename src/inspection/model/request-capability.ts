import { Predicate, Result, Schema } from "effect";
import type { JsonObject as RequestExample } from "effect/Schema";

import { inspectionIntentSchema } from "#typepeek/inspection/model/protocol-vocabulary";

const MAX_CAPABILITY_FIELD_NAME_BYTES = 64;
const MAX_CAPABILITY_FIELDS = 8;

const capabilityFieldNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    (name) => Buffer.byteLength(name) <= MAX_CAPABILITY_FIELD_NAME_BYTES,
    {
      expected: "a bounded capability field name",
    }
  )
);

const positiveNaturalSchema = Schema.Natural.check(Schema.isGreaterThan(0));

const stringFieldCapabilityFields = {
  format: Schema.optionalKey(Schema.Literal("absolute-path")),
  kind: Schema.Literal("string"),
  maxBytes: Schema.optionalKey(positiveNaturalSchema),
  minBytes: Schema.optionalKey(Schema.Natural),
} as const;

const enumFieldCapabilityFields = {
  default: Schema.optionalKey(Schema.String),
  kind: Schema.Literal("enum"),
  values: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.isUnique()
  ),
} as const;

const collectionFieldCapabilityFields = {
  kind: Schema.Literals(["inspection-plan-queries", "member-path"]),
  maxItemBytes: Schema.optionalKey(positiveNaturalSchema),
  maxItems: positiveNaturalSchema,
  minItems: Schema.Natural,
  qualified: Schema.optionalKey(
    Schema.Struct({
      name: Schema.Literal("name"),
      space: Schema.Literal("space"),
      values: Schema.Tuple([
        Schema.Literal("type"),
        Schema.Literal("value"),
        Schema.Literal("namespace"),
      ]),
    })
  ),
  unqualified: Schema.optionalKey(Schema.Literal(true)),
} as const;

const stringFieldCapabilityStruct = Schema.Struct(stringFieldCapabilityFields);
const enumFieldCapabilityStruct = Schema.Struct(enumFieldCapabilityFields);

const collectionFieldCapabilityStruct = Schema.Struct(
  collectionFieldCapabilityFields
);

const stringFieldCapabilitySchema = stringFieldCapabilityStruct.check(
  Schema.makeFilter(
    ({ minBytes, maxBytes }: typeof stringFieldCapabilityStruct.Type) =>
      minBytes === undefined || maxBytes === undefined || minBytes <= maxBytes
        ? undefined
        : { issue: "minBytes must not exceed maxBytes", path: ["minBytes"] }
  )
);

const enumFieldCapabilitySchema = enumFieldCapabilityStruct.check(
  Schema.makeFilter(
    ({
      default: defaultValue,
      values,
    }: typeof enumFieldCapabilityStruct.Type) =>
      defaultValue === undefined || values.includes(defaultValue)
        ? undefined
        : { issue: "default must be one of values", path: ["default"] }
  )
);

const collectionFieldCapabilitySchema = collectionFieldCapabilityStruct.check(
  Schema.makeFilter(
    ({ minItems, maxItems }: typeof collectionFieldCapabilityStruct.Type) =>
      minItems <= maxItems
        ? undefined
        : { issue: "minItems must not exceed maxItems", path: ["minItems"] }
  )
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

export type InspectionRequestFieldCapability =
  typeof inspectionRequestFieldCapabilitySchema.Type;

const isInspectionRequestFieldCapability = Schema.is(
  inspectionRequestFieldCapabilitySchema
);

const requestFieldDescriptorSchema = <
  FieldNameSchema extends Schema.ConstraintDecoder<string>,
>(
  fieldNameSchema: FieldNameSchema
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
    })
  );
};

export type InspectionRequestFieldDescriptorFor<Name extends string> =
  ReturnType<typeof requestFieldDescriptorSchema<Schema.Literal<Name>>>["Type"];

const inspectionRequestFieldDescriptorSchema = requestFieldDescriptorSchema(
  capabilityFieldNameSchema
);

const inspectionRequestDescriptorSchema = Schema.Struct({
  example: Schema.JsonObject,
  fields: Schema.Array(inspectionRequestFieldDescriptorSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CAPABILITY_FIELDS)
  ),
  intent: inspectionIntentSchema,
});

export type SchemaDerivedRequestDescriptor =
  typeof inspectionRequestDescriptorSchema.Type;

// oxlint-disable typescript/no-namespace, eslint/no-shadow -- Effect requires its Annotations namespace for schema metadata augmentation.
declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly inspectionRequestField?: InspectionRequestFieldCapability;
      readonly inspectionRequestExample?: RequestExample;
    }
  }
}

// oxlint-enable typescript/no-namespace, eslint/no-shadow

/** Attaches capability metadata to a request field schema. */
export const withRequestFieldCapability = function withRequestFieldCapability<
  SchemaType extends Schema.Top,
>(
  schema: SchemaType,
  capability: InspectionRequestFieldCapability
): SchemaType["Rebuild"] {
  const validated = Schema.decodeSync(inspectionRequestFieldCapabilitySchema)(
    capability
  );

  return schema.annotate({ inspectionRequestField: validated });
};

export const inspectionRequestFieldDescriptorFor =
  function inspectionRequestFieldDescriptorFor<
    FieldNameSchema extends Schema.ConstraintDecoder<string>,
  >(fieldNameSchema: FieldNameSchema) {
    return requestFieldDescriptorSchema(fieldNameSchema);
  };

const requiredPropertyNames = function requiredPropertyNames(
  schema: Schema.Struct<Schema.Struct.Fields>
): ReadonlySet<string> {
  const root = Schema.toJsonSchemaDocument(schema).schema;
  const { required } = root;

  if (
    !Array.isArray(required) ||
    !required.every((name) => Predicate.isString(name))
  ) {
    throw new Error("Request schema did not produce a required-property list.");
  }

  return new Set(required);
};

export const deriveInspectionRequestDescriptor =
  function deriveInspectionRequestDescriptor(
    intent: typeof inspectionIntentSchema.Type,
    schema: Schema.Struct<Schema.Struct.Fields> &
      Schema.ConstraintDecoder<unknown>
  ): SchemaDerivedRequestDescriptor {
    const requiredNames = requiredPropertyNames(schema);

    const fields = Object.entries(schema.fields).map(([name, field]) => {
      const capability =
        Schema.resolveAnnotations(field)?.inspectionRequestField;

      if (capability === undefined) {
        throw new Error(
          `Request field "${name}" is missing capability metadata.`
        );
      }

      return Schema.decodeUnknownSync(inspectionRequestFieldDescriptorSchema)({
        name,
        required: requiredNames.has(name),
        ...capability,
      });
    });

    const example = Schema.resolveAnnotations(schema)?.inspectionRequestExample;

    if (
      example === undefined ||
      Result.isFailure(Schema.decodeUnknownResult(schema)(example))
    ) {
      throw new Error(
        `Request schema "${intent}" must declare one valid encoded example.`
      );
    }

    return Schema.decodeSync(inspectionRequestDescriptorSchema)({
      example,
      fields,
      intent,
    });
  };
