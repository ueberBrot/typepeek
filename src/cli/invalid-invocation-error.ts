import { Schema } from "effect";

const taggedError = Schema.TaggedError;

export class InvalidInvocationError extends taggedError<
  InvalidInvocationError,
  { readonly brand: unique symbol }
>()("InvalidInvocationError", { message: Schema.String }) {}
