import { runMain } from "@effect/platform-bun/BunRuntime";
import { layer as bunStdioLayer } from "@effect/platform-bun/BunStdio";
import { Effect, Schema, Stdio } from "effect";

import { encodeInspectionCacheWriteReceipt } from "#typepeek/inspection/cache/inspection-cache-codec";
import { installAnalysisHeapLimit } from "#typepeek/inspection/execution/analysis-heap";
import { analyzeInspectionEffect } from "#typepeek/inspection/execution/analyze";
import {
  beginInspectionProfile,
  completeInspectionProfile,
  profileInspectionPhase,
  profileInspectionEffect,
} from "#typepeek/inspection/execution/performance-profile";
import { readAnalysisRequest } from "#typepeek/inspection/model/request-definitions";
import { writeAnalysisMetadata } from "#typepeek/platform/node-analysis-metadata";
import { writeStdout, writeStderr } from "#typepeek/platform/stdio";
import { collectByteStream } from "#typepeek/shared/byte-stream";
import { decodeJson } from "#typepeek/shared/json-data";

// Validate subprocess input even when the caller bypasses Inspection Core.
const program = Effect.gen(function* program() {
  if (process.versions.bun !== undefined) {
    yield* installAnalysisHeapLimit();
  }

  beginInspectionProfile();

  const stdio = yield* Stdio.Stdio;
  const input = yield* collectByteStream(stdio.stdin, 16 * 1024);

  const message = decodeJson(
    Schema.Json,
    new TextDecoder("utf-8", { fatal: true }).decode(input)
  );

  const requestReading = profileInspectionPhase("request-validation", () =>
    readAnalysisRequest(message)
  );

  const execution = requestReading.accepted
    ? yield* profileInspectionEffect(
        "analysis",
        analyzeInspectionEffect(
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
      yield* writeAnalysisMetadata(JSON.stringify(encoded));
    }
  }

  const { outcome } = execution;

  yield* writeStdout(JSON.stringify(outcome));

  const profile = completeInspectionProfile();

  if (profile !== undefined) {
    yield* writeStderr(`${JSON.stringify(profile)}\n`);
  }
});

runMain(program.pipe(Effect.scoped, Effect.provide(bunStdioLayer)), {
  disableErrorReporting: true,
});
