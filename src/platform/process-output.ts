import { Effect, Schema, Stream } from "effect";

const taggedError = Schema.TaggedError;

export class ProcessOutputLimitError extends taggedError<
  ProcessOutputLimitError,
  { readonly brand: unique symbol }
>()("ProcessOutputLimitError", { limit: Schema.Finite }) {}

/** Enforce byte budgets before retaining or decoding process output. */
export const boundedProcessOutput = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
) =>
  stream.pipe(
    Stream.mapAccum(
      () => 0,
      (bytes, chunk) =>
        [
          bytes + chunk.byteLength,
          [{ bytes: bytes + chunk.byteLength, chunk }],
        ] as const
    ),
    Stream.mapEffect(({ bytes, chunk }) =>
      bytes > limit
        ? Effect.fail(new ProcessOutputLimitError({ limit }))
        : Effect.succeed(chunk)
    )
  );

export const collectProcessOutput = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
) =>
  boundedProcessOutput(stream, limit).pipe(
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(chunks))
  );
