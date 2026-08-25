import { isUtf8 } from "node:buffer";
import type { Readable } from "node:stream";

import { serializeTerminalSafeJson } from "#typepeek/output-safety";

const MAX_PROTOCOL_INPUT_BYTES = 32 * 1_024;
const MAX_PROTOCOL_OUTPUT_BYTES = 128 * 1_024;

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

export type ProtocolWireReading =
  | { readonly accepted: true; readonly value: unknown }
  | { readonly accepted: false; readonly error: ProtocolWireError };

/** Reads one bounded UTF-8 JSON value without buffering an unbounded stream. */
export async function readProtocolWireInput(input: Readable): Promise<ProtocolWireReading> {
  const reading = await readBoundedWireBytes(input);
  return Buffer.isBuffer(reading) ? parseProtocolWireInput(reading) : reading;
}

async function readBoundedWireBytes(input: Readable): Promise<Buffer | ProtocolWireReading> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > MAX_PROTOCOL_INPUT_BYTES) {
      input.destroy();
      return invalidProtocolWireInput("input-too-large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function parseProtocolWireInput(inputBuffer: Buffer): ProtocolWireReading {
  if (!isUtf8(inputBuffer)) {
    return invalidProtocolWireInput("invalid-utf8");
  }
  const text = inputBuffer.toString("utf8");
  if (text.trim() === "") {
    return invalidProtocolWireInput("empty-input");
  }
  try {
    return { accepted: true, value: JSON.parse(text) as unknown };
  } catch {
    return invalidProtocolWireInput("malformed-json");
  }
}

/** Produces bounded terminal-safe JSON for the protocol stdout wire. */
export function renderProtocolWireValue(value: unknown): string | undefined {
  const text = serializeTerminalSafeJson(value);
  return Buffer.byteLength(text) <= MAX_PROTOCOL_OUTPUT_BYTES ? `${text}\n` : undefined;
}

function invalidProtocolWireInput(reason: ProtocolWireInputFailureReason): ProtocolWireReading {
  return {
    accepted: false,
    error: {
      wireVersion: "1",
      status: "invalid-input",
      reason,
      message: "Typepeek received invalid protocol input.",
    },
  };
}

export function internalProtocolWireError(reason: "unexpected-error"): ProtocolWireError {
  return {
    wireVersion: "1",
    status: "internal-error",
    reason,
    message: "Typepeek could not complete the protocol exchange.",
  };
}
