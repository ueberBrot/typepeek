import { isUtf8 } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import { Schema } from "effect";
import { constVoid } from "effect/Function";

import {
  INSPECTION_PROTOCOL_VERSION,
  invokeInspectionProtocol,
} from "#typepeek/inspection";
import type { InspectionProtocolResponse } from "#typepeek/inspection/inspection-protocol-schema";
import { decodeJson } from "#typepeek/json-data";
import { serializeTerminalSafeJson } from "#typepeek/output-safety";

const MAX_PROTOCOL_INPUT_BYTES = 32 * 1024;
const MAX_PROTOCOL_OUTPUT_BYTES = 128 * 1024;
const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;

type ProtocolWireValue = InspectionProtocolResponse | ProtocolWireError;

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
  | {
      readonly accepted: true;
      readonly value: Schema.Json;
    }
  | {
      readonly accepted: false;
      readonly error: ProtocolWireError;
    };

class ProtocolOutputError extends Error {
  override name = "ProtocolOutputError";
}

/** Produces bounded terminal-safe JSON for the protocol stdout wire. */
const renderProtocolWireValue = function renderProtocolWireValue(
  value: ProtocolWireValue
): string | undefined {
  const text = serializeTerminalSafeJson(value);

  return Buffer.byteLength(text) <= MAX_PROTOCOL_OUTPUT_BYTES
    ? `${text}\n`
    : undefined;
};

const writeProtocolOutput = async function writeProtocolOutput(
  output: Writable,
  rendering: string
): Promise<void> {
  const completion = Promise.withResolvers<undefined>();
  const { resolve, reject } = completion;

  const onError = () => {
    reject(new ProtocolOutputError());
  };

  output.once("error", onError);
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Writable.write exposes completion through this native callback.
  output.write(rendering, (error) => {
    if (error !== undefined && error !== null) {
      onError();
    } else {
      output.off("error", onError);
      resolve(undefined);
    }
  });
  await completion.promise;
};

const invalidProtocolWireInput = function invalidProtocolWireInput(
  reason: ProtocolWireInputFailureReason
): ProtocolWireReading {
  return {
    accepted: false,
    error: {
      message: "Typepeek received invalid protocol input.",
      reason,
      status: "invalid-input",
      wireVersion: "1",
    },
  };
};

const parseProtocolWireInput = function parseProtocolWireInput(
  inputBuffer: Buffer
): ProtocolWireReading {
  if (!isUtf8(inputBuffer)) {
    return invalidProtocolWireInput("invalid-utf8");
  }

  const text = inputBuffer.toString("utf-8");

  if (text.trim() === "") {
    return invalidProtocolWireInput("empty-input");
  }

  try {
    return { accepted: true, value: decodeJson(Schema.Json, text) };
  } catch {
    return invalidProtocolWireInput("malformed-json");
  }
};

/**
 * Reads newline-delimited requests with a separate byte limit for each line.
 * Each input line yields an independently bounded and decoded request.
 */
const readProtocolWireStream = async function* readProtocolWireStream(
  input: Readable
): AsyncGenerator<ProtocolWireReading> {
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

        if (!reading.accepted) {
          return;
        }

        chunks = [];
        bytes = 0;
      }

      start = end + 1;
    }
  }

  if (bytes > 0) {
    yield parseProtocolWireInput(Buffer.concat(chunks, bytes));
  }
};

const protocolOutputLimitResponse = function protocolOutputLimitResponse() {
  return {
    outcome: {
      exceededBudget: "json-output",
      message: "Inspection exceeded its protocol output limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    },
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
  } as const;
};

const internalProtocolWireError =
  function internalProtocolWireError(): ProtocolWireError {
    return {
      message: "Typepeek could not complete the protocol exchange.",
      reason: "unexpected-error",
      status: "internal-error",
      wireVersion: "1",
    };
  };

/** Exchanges ordered, bounded JSON lines and returns the aggregate process exit status. */
export const runProtocolWireStream = async function runProtocolWireStream(
  input: Readable,
  output: Writable
): Promise<number> {
  let exitCode = 0;

  const write = async (
    value: ProtocolWireValue,
    failureExitCode: number
  ): Promise<boolean> => {
    const rendering = renderProtocolWireValue(value);

    if (rendering === undefined) {
      return false;
    }

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
          response.outcome.status === "success"
            ? 0
            : INSPECTION_FAILURE_EXIT_CODE
        ))
      ) {
        await write(
          protocolOutputLimitResponse(),
          INSPECTION_FAILURE_EXIT_CODE
        );
      }
    }
  } catch (error) {
    exitCode = INTERNAL_ERROR_EXIT_CODE;

    if (!(error instanceof ProtocolOutputError)) {
      await write(internalProtocolWireError(), INTERNAL_ERROR_EXIT_CODE).catch(
        constVoid
      );
    }
  }

  return exitCode;
};
