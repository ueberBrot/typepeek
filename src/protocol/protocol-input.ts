import { Effect, Schema, Stream } from "effect";

import { decodeJson } from "#typepeek/shared/json-data";

const MAX_PROTOCOL_INPUT_BYTES = 32 * 1024;

export type ProtocolWireInputFailureReason =
  | "empty-input"
  | "input-too-large"
  | "invalid-utf8"
  | "malformed-json";

export interface ProtocolWireError {
  readonly wireVersion: "1";
  readonly status: "internal-error" | "invalid-input";
  readonly reason: ProtocolWireInputFailureReason | "unexpected-error";
  readonly message: string;
}

type ProtocolWireReading =
  | { readonly accepted: true; readonly value: Schema.Json }
  | { readonly accepted: false; readonly error: ProtocolWireError };

const invalidProtocolWireInput = (
  reason: ProtocolWireInputFailureReason
): ProtocolWireReading => ({
  accepted: false,
  error: {
    message: "Typepeek received invalid protocol input.",
    reason,
    status: "invalid-input",
    wireVersion: "1",
  },
});

const parseProtocolWireInput = (input: Uint8Array): ProtocolWireReading => {
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return invalidProtocolWireInput("invalid-utf8");
  }

  if (text.trim() === "") {
    return invalidProtocolWireInput("empty-input");
  }

  try {
    return { accepted: true, value: decodeJson(Schema.Json, text) };
  } catch {
    return invalidProtocolWireInput("malformed-json");
  }
};

class ProtocolInput {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  next(
    chunk: Uint8Array,
    start: number
  ): readonly [ProtocolWireReading, number] | undefined {
    if (start >= chunk.length) {
      return undefined;
    }

    const newline = chunk.indexOf(0x0a, start);
    const end = newline === -1 ? chunk.length : newline;
    this.bytes += end - start;

    if (this.bytes > MAX_PROTOCOL_INPUT_BYTES) {
      return [invalidProtocolWireInput("input-too-large"), chunk.length];
    }

    this.chunks.push(chunk.slice(start, end));

    return newline === -1 ? undefined : [this.completeLine(), end + 1];
  }

  finish(): ProtocolWireReading | undefined {
    return this.bytes > 0 ? this.completeLine() : undefined;
  }

  private completeLine(): ProtocolWireReading {
    const value = new Uint8Array(this.bytes);
    let offset = 0;

    for (const chunk of this.chunks) {
      value.set(chunk, offset);
      offset += chunk.length;
    }

    this.chunks = [];
    this.bytes = 0;

    return parseProtocolWireInput(value);
  }
}

export const readProtocolWireStream = <E, R>(
  input: Stream.Stream<Uint8Array, E, R>
) =>
  Stream.suspend(() => {
    const reader = new ProtocolInput();

    return input.pipe(
      Stream.flatMap((chunk) =>
        Stream.unfold(0, (start) => Effect.succeed(reader.next(chunk, start)))
      ),
      Stream.concat(
        Stream.suspend(() => {
          const last = reader.finish();

          return last === undefined ? Stream.empty : Stream.succeed(last);
        })
      ),
      Stream.takeUntil((reading) => !reading.accepted)
    );
  });
