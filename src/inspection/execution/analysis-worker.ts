import { createWriteStream } from "node:fs";

import { runMain } from "@effect/platform-node-shared/NodeRuntime";
import { fromWritable } from "@effect/platform-node-shared/NodeSink";
import { layer as nodeStdioLayer } from "@effect/platform-node-shared/NodeStdio";
import { Effect, Schema, Stdio, Stream } from "effect";

import { encodeInspectionCacheWriteReceipt } from "#typepeek/inspection/cache/inspection-cache-codec";
import { analyzeInspection } from "#typepeek/inspection/execution/analyze";
import {
  beginInspectionProfile,
  completeInspectionProfile,
  profileInspectionPhase,
} from "#typepeek/inspection/execution/performance-profile";
import { readAnalysisRequest } from "#typepeek/inspection/model/request-definitions";
import { collectProcessOutput } from "#typepeek/platform/process-output";
import { decodeJson } from "#typepeek/shared/json-data";

const taggedError = Schema.TaggedError;

class AnalysisWorkerIOError extends taggedError<
  AnalysisWorkerIOError,
  { readonly brand: unique symbol }
>()("AnalysisWorkerIOError", { cause: Schema.Defect() }) {}

// Validate subprocess input even when the caller bypasses Inspection Core.
const program = Effect.gen(function* program() {
  beginInspectionProfile();

  const stdio = yield* Stdio.Stdio;
  const input = yield* collectProcessOutput(stdio.stdin, 16 * 1024);

  const message = decodeJson(
    Schema.Json,
    new TextDecoder("utf-8", { fatal: true }).decode(input)
  );

  const requestReading = profileInspectionPhase("request-validation", () =>
    readAnalysisRequest(message)
  );

  const execution = requestReading.accepted
    ? profileInspectionPhase("analysis", () =>
        analyzeInspection(
          requestReading.request,
          process.env["TYPEPEEK_CACHE_BYPASS"] !== "1"
        )
      )
    : { outcome: requestReading.outcome };

  const { cacheMessage } = execution;

  if (cacheMessage !== undefined) {
    const encoded =
      cacheMessage.kind === "inspection-cache-write"
        ? encodeInspectionCacheWriteReceipt(cacheMessage)
        : cacheMessage;

    if (encoded !== undefined) {
      yield* Stream.make(JSON.stringify(encoded)).pipe(
        Stream.run(
          fromWritable({
            endOnDone: true,
            evaluate: () => createWriteStream("", { fd: 3 }),
            onError: (cause) => new AnalysisWorkerIOError({ cause }),
          })
        )
      );
    }
  }

  const { outcome } = execution;

  process.stdout.write(JSON.stringify(outcome));

  const profile = completeInspectionProfile();

  if (profile !== undefined) {
    process.stderr.write(`${JSON.stringify(profile)}\n`);
  }
});

runMain(program.pipe(Effect.provide(nodeStdioLayer)), {
  disableErrorReporting: true,
});
