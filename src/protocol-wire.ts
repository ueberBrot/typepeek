import { isUtf8 } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import { INSPECTION_PROTOCOL_VERSION, invokeInspectionProtocol } from "#typepeek/inspection";
import { serializeTerminalSafeJson } from "#typepeek/output-safety";

const MAX_PROTOCOL_INPUT_BYTES = 32 * 1_024;
const MAX_PROTOCOL_OUTPUT_BYTES = 128 * 1_024;
const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;

type ProtocolWireInputFailureReason =
  | "empty-input"
  | "input-too-large"
  | "invalid-utf8"
  | "malformed-json";

interface ProtocolWireError {
  readonly wireVersion: "1";
  readonly status: "internal-error" | "invalid-input";
  readonly reason: ProtocolWireInputFailureReason | "unexpected-error";
  readonly message: string;
}

type ProtocolWireReading =
  | { readonly accepted: true; readonly value: unknown }
  | { readonly accepted: false; readonly error: ProtocolWireError };

class ProtocolOutputError extends Error {}

/** Exchanges ordered, bounded JSON lines and returns the aggregate process exit status. */
export async function runProtocolWireStream(input: Readable, output: Writable): Promise<number> {
  let exitCode = 0;
  const write = async (value: unknown, failureExitCode: number): Promise<boolean> => {
    const rendering = renderProtocolWireValue(value);
    if (rendering === undefined) return false;
    exitCode = Math.max(exitCode, failureExitCode);
    await writeProtocolOutput(output, rendering);
    return true;
  };
  try {
    for await (const reading of readProtocolWireStream(input)) {
      if (!reading.accepted) {
        await write(reading.error, INVALID_INVOCATION_EXIT_CODE);
        return exitCode;
      }
      const response = await invokeInspectionProtocol(reading.value);
      if (
        !(await write(
          response,
          response.outcome.status === "success" ? 0 : INSPECTION_FAILURE_EXIT_CODE,
        ))
      ) {
        await write(protocolOutputLimitResponse(), INSPECTION_FAILURE_EXIT_CODE);
      }
    }
  } catch (error) {
    exitCode = INTERNAL_ERROR_EXIT_CODE;
    if (!(error instanceof ProtocolOutputError)) {
      await write(internalProtocolWireError(), INTERNAL_ERROR_EXIT_CODE).catch(() => undefined);
    }
  }
  return exitCode;
}

function writeProtocolOutput(output: Writable, rendering: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = () => reject(new ProtocolOutputError());
    output.once("error", onError);
    output.write(rendering, (error) => {
      if (error !== undefined && error !== null) {
        onError();
      } else {
        output.off("error", onError);
        resolve();
      }
    });
  });
}

function protocolOutputLimitResponse() {
  return {
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    outcome: {
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget: "json-output",
      message: "Inspection exceeded its protocol output limit.",
    },
  } as const;
}

/** Reads newline-delimited requests with a separate byte limit for each line. */
async function* readProtocolWireStream(input: Readable): AsyncGenerator<ProtocolWireReading> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(0x0a, start);
      const end = newline === -1 ? buffer.length : newline;
      bytes += end - start;
      if (bytes > MAX_PROTOCOL_INPUT_BYTES) {
        input.destroy();
        yield invalidProtocolWireInput("input-too-large");
        return;
      }
      chunks.push(buffer.subarray(start, end));
      if (newline !== -1) {
        const reading = parseProtocolWireInput(Buffer.concat(chunks, bytes));
        yield reading;
        if (!reading.accepted) return;
        chunks = [];
        bytes = 0;
      }
      start = end + 1;
    }
  }
  if (bytes > 0) yield parseProtocolWireInput(Buffer.concat(chunks, bytes));
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
function renderProtocolWireValue(value: unknown): string | undefined {
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

function internalProtocolWireError(): ProtocolWireError {
  return {
    wireVersion: "1",
    status: "internal-error",
    reason: "unexpected-error",
    message: "Typepeek could not complete the protocol exchange.",
  };
}
