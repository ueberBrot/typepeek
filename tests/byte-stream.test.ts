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
