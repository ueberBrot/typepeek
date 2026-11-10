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

export const collectByteStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
) =>
  boundedByteStream(stream, limit).pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      const bytes = new Uint8Array(
        chunks.reduce((length, chunk) => length + chunk.byteLength, 0)
      );

      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return bytes;
    })
  );
