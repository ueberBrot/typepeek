import { Effect, Schema, Stream } from "effect";

const taggedError = Schema.TaggedError;

export class ByteStreamLimitError extends taggedError<
  ByteStreamLimitError,
  { readonly brand: unique symbol }
>()("ByteStreamLimitError", { limit: Schema.Finite }) {}

/** Enforce byte budgets before retaining or decoding process output. */
export const boundedByteStream = <E, R>(
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
        ? Effect.fail(new ByteStreamLimitError({ limit }))
        : Effect.succeed(chunk)
    )
  );

export const collectByteStream = Effect.fnUntraced(function* collectByteStream<
  E,
  R,
>(stream: Stream.Stream<Uint8Array, E, R>, limit: number) {
  let bytes = new Uint8Array(0);
  let length = 0;

  yield* stream.pipe(
    Stream.runForEachArray((chunks) => {
      const required = chunks.reduce(
        (size, chunk) => size + chunk.byteLength,
        length
      );

      if (required > limit) {
        return Effect.fail(new ByteStreamLimitError({ limit }));
      }

      return Effect.sync(() => {
        if (required > bytes.byteLength) {
          const capacity = Math.min(
            limit,
            Math.max(4096, required, bytes.byteLength * 2)
          );

          const expanded = new Uint8Array(capacity);
          expanded.set(bytes.subarray(0, length));
          bytes = expanded;
        }

        for (const chunk of chunks) {
          bytes.set(chunk, length);
          length += chunk.byteLength;
        }
      });
    })
  );

  return length === bytes.byteLength ? bytes : bytes.slice(0, length);
});
