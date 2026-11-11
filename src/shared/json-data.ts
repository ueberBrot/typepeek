import { Predicate, Schema } from "effect";

/** JSON serialization input also permits undefined properties, which JSON.stringify omits. */
export type JsonInput = Schema.Json | undefined | JsonInputCollection;

export type JsonInputCollection = readonly JsonInput[] | JsonInputProperties;

export interface JsonInputProperties {
  readonly [key: string]: JsonInput;
}

export const isJsonInputArray = (
  value: JsonInput
): value is readonly JsonInput[] => Array.isArray(value);

export const isJsonInputObject = (
  value: JsonInput
): value is JsonInputProperties => Predicate.isReadonlyObject(value);

export const mutableJsonObjectSchema = Schema.Record(
  Schema.String,
  Schema.mutableKey(Schema.MutableJson)
);

/** Narrows an already validated JSON value without discarding its element contract. */
export const isJsonArray = (
  value: Schema.Json | undefined
): value is readonly Schema.Json[] => Array.isArray(value);

/** Narrows an already validated JSON value to its object members. */
export const isJsonObject = (
  value: Schema.Json | undefined
): value is Schema.JsonObject => Predicate.isReadonlyObject(value);

/** Parses JSON and checks its contract while retaining unmodeled data fields. */
export const decodeJson = <Definition extends Schema.Constraint>(
  schema: Definition,
  text: string
): Definition["Type"] => {
  const value = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(text);

  if (!Schema.is(schema)(value)) {
    // Reuse the schema's field-level diagnostic while preserving accepted data verbatim.
    Schema.decodeSync(Schema.toType(schema))(value);
    throw new TypeError("JSON does not match the expected data contract.");
  }

  return value;
};
