import { Schema } from "effect";

const taggedError = Schema.TaggedError;

export class InspectionFailureError extends taggedError<
  InspectionFailureError,
  { readonly brand: unique symbol }
>()("InspectionFailureError", { message: Schema.String }) {}
