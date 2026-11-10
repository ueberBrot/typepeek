import { Cause, Effect, Option, Schema, Stdio, Stream } from "effect";

import { INSPECTION_PROTOCOL_VERSION } from "#typepeek/inspection";
import { invokeInspectionProtocolEffect } from "#typepeek/inspection/model/inspection-protocol";
import type { InspectionProtocolResponse } from "#typepeek/inspection/model/inspection-protocol-schema";
import { serializeTerminalSafeJson } from "#typepeek/presentation/output-safety";
import { readProtocolWireStream } from "#typepeek/protocol/protocol-input";
import type { ProtocolWireError } from "#typepeek/protocol/protocol-input";

const MAX_PROTOCOL_OUTPUT_BYTES = 128 * 1024;
const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;

type ProtocolWireValue = InspectionProtocolResponse | ProtocolWireError;

const taggedError = Schema.TaggedError;

class ProtocolOutputError extends taggedError<
  ProtocolOutputError,
  { readonly brand: unique symbol }
>()("ProtocolOutputError", {}) {}

const protocolOutputLimitResponse = () =>
  ({
    outcome: {
      exceededBudget: "json-output",
      message: "Inspection exceeded its protocol output limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    },
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
  }) as const;

const internalProtocolWireError = (): ProtocolWireError => ({
  message: "Typepeek could not complete the protocol exchange.",
  reason: "unexpected-error",
  status: "internal-error",
  wireVersion: "1",
});

/** Owns ordered protocol requests, bounded framing, output backpressure, and interruption. */
export const runProtocolWire = Effect.fnUntraced(function* runProtocolWire() {
  const stdio = yield* Stdio.Stdio;
  let exitCode = 0;

  const write = (value: ProtocolWireValue, failureExitCode: number) =>
    Effect.gen(function* writeValue() {
      const text = serializeTerminalSafeJson(value);

      if (Buffer.byteLength(text) > MAX_PROTOCOL_OUTPUT_BYTES) {
        return false;
      }

      yield* Stream.make(`${text}\n`).pipe(
        Stream.run(stdio.stdout()),
        Effect.mapError(() => new ProtocolOutputError({}))
      );
      exitCode = Math.max(exitCode, failureExitCode);

      return true;
    });

  return yield* readProtocolWireStream(stdio.stdin).pipe(
    Stream.runForEachWhile((reading) =>
      Effect.gen(function* respond() {
        if (!reading.accepted) {
          yield* write(reading.error, INVALID_INVOCATION_EXIT_CODE);

          return false;
        }

        const response = yield* invokeInspectionProtocolEffect(reading.value);

        const written = yield* write(
          response,
          response.outcome.status === "success"
            ? 0
            : INSPECTION_FAILURE_EXIT_CODE
        );

        if (!written) {
          yield* write(
            protocolOutputLimitResponse(),
            INSPECTION_FAILURE_EXIT_CODE
          );
        }

        return true;
      })
    ),
    Effect.map(() => exitCode),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }

      const error = Option.getOrUndefined(Cause.findErrorOption(cause));

      return (
        error instanceof ProtocolOutputError
          ? Effect.void
          : write(internalProtocolWireError(), INTERNAL_ERROR_EXIT_CODE).pipe(
              Effect.ignore
            )
      ).pipe(Effect.as(INTERNAL_ERROR_EXIT_CODE));
    })
  );
});
