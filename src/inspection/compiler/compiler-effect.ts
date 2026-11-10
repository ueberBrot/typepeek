import { Effect, Schema } from "effect";

const taggedError = Schema.TaggedError;

export class CompilerTaskError extends taggedError<
  CompilerTaskError,
  {
    readonly brand: unique symbol;
  }
>()("CompilerTaskError", { cause: Schema.Defect() }) {}

export const compilerTask = <Value>(run: () => Promise<Value>) =>
  Effect.tryPromise({
    catch: (cause) => new CompilerTaskError({ cause }),
    try: run,
  });
