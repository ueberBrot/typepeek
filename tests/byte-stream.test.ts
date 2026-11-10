import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ByteStreamLimitError,
  collectByteStream,
} from "#typepeek/shared/byte-stream";
import { runAdapterEffect } from "#typepeek/shared/effect-adapter";

const encoder = new TextEncoder();

describe("bounded byte streams", () => {
  it("accepts the exact byte budget", async () => {
    await expect(
      runAdapterEffect(collectByteStream(Stream.make(new Uint8Array(3)), 3))
    ).resolves.toStrictEqual(new Uint8Array(3));
  });

  it("rejects the first byte beyond its budget", async () => {
    await expect(
      runAdapterEffect(collectByteStream(Stream.make(new Uint8Array(4)), 3))
    ).rejects.toMatchObject({ _tag: "ByteStreamLimitError", limit: 3 });
  });

  it("enforces the aggregate budget across a batch of smaller chunks", async () => {
    await expect(
      runAdapterEffect(
        collectByteStream(Stream.make(new Uint8Array(2), new Uint8Array(2)), 3)
      )
    ).rejects.toMatchObject({ _tag: "ByteStreamLimitError", limit: 3 });
  });

  it("releases unused backing storage after collection", async () => {
    const result = await runAdapterEffect(
      collectByteStream(Stream.make(Uint8Array.of(1, 2, 3)), 8192)
    );

    expect(result).toStrictEqual(Uint8Array.of(1, 2, 3));
    expect(result.buffer.byteLength).toBe(3);
  });

  it("joins bytes before decoding split UTF-8 characters", async () => {
    const bytes = encoder.encode("a💡z");

    const collected = await runAdapterEffect(
      collectByteStream(
        Stream.make(bytes.slice(0, 3), bytes.slice(3)),
        bytes.length
      )
    );

    expect(new TextDecoder("utf-8", { fatal: true }).decode(collected)).toBe(
      "a💡z"
    );
  });

  it("preserves bytes when an upstream reader reuses its buffer", async () => {
    const buffer = new Uint8Array(2);

    const input = Stream.unfold(1, (value) =>
      Effect.sync(() =>
        value > 3 ? undefined : ([buffer.fill(value), value + 1] as const)
      )
    );

    await expect(
      runAdapterEffect(collectByteStream(input, 6))
    ).resolves.toStrictEqual(Uint8Array.of(1, 1, 2, 2, 3, 3));
  });

  it("handles empty and fragmented chunks with bounded storage", async () => {
    const input = Stream.fromIterable(
      Array.from({ length: 10_000 }, (_, index) =>
        index % 2 === 0 ? new Uint8Array() : Uint8Array.of(index % 256)
      )
    );

    const expected = Uint8Array.from(
      Array.from({ length: 5000 }, (_, index) => (2 * index + 1) % 256)
    );

    const result = await runAdapterEffect(collectByteStream(input, 5000));
    expect(result).toStrictEqual(expected);
    expect(result.buffer.byteLength).toBe(5000);
  });

  it("allocates independent storage for each execution", async () => {
    const bytes = Uint8Array.of(1, 2);
    const collection = collectByteStream(Stream.make(bytes), 2);
    const first = await runAdapterEffect(collection);
    bytes.fill(3);
    const second = await runAdapterEffect(collection);

    expect(first).toStrictEqual(Uint8Array.of(1, 2));
    expect(second).toStrictEqual(Uint8Array.of(3, 3));
  });

  it("closes its input on overflow without pulling more bytes", async () => {
    let closed = false;
    let pulls = 0;

    const input = Stream.unwrap(
      Effect.acquireRelease(
        Effect.succeed(
          Stream.fromEffectRepeat(
            Effect.sync(() => {
              pulls += 1;

              return Uint8Array.of(pulls);
            })
          )
        ),
        () =>
          Effect.sync(() => {
            closed = true;
          })
      )
    );

    await expect(
      runAdapterEffect(collectByteStream(input, 2))
    ).rejects.toMatchObject({
      _tag: "ByteStreamLimitError",
    });
    expect(pulls).toBe(3);
    expect(closed).toBeTruthy();
  });

  it("preserves an upstream failure instead of returning partial bytes", async () => {
    const failure = new ByteStreamLimitError({ limit: 42 });

    const input = Stream.make(encoder.encode("partial")).pipe(
      Stream.concat(Stream.fail(failure))
    );

    await expect(runAdapterEffect(collectByteStream(input, 128))).rejects.toBe(
      failure
    );
  });

  it("closes its input scope when collection is interrupted", async () => {
    const entered = Promise.withResolvers<undefined>();
    let closed = false;

    const input = Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => {
          entered.resolve(undefined);

          return Stream.never;
        }),
        () =>
          Effect.sync(() => {
            closed = true;
          })
      )
    );

    const fiber = Effect.runFork(collectByteStream(input, 128));
    await entered.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(closed).toBeTruthy();
  });
});
