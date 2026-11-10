import { fileURLToPath } from "node:url";

import { Effect, Exit, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";

import { MAX_CACHE_RECEIPT_BYTES } from "#typepeek/inspection/cache/inspection-cache-codec";
import { removeInspectionCacheEntry } from "#typepeek/inspection/cache/inspection-cache-files";
import {
  readInspectionCacheHitNotice,
  writeValidatedInspectionCacheOutcome,
} from "#typepeek/inspection/cache/inspection-cache-storage";
import {
  forwardInspectionProfile,
  inspectionProfilingEnabled,
} from "#typepeek/inspection/execution/performance-profile";
import {
  INSPECTION_BUDGET_POLICY,
  MAX_ANALYSIS_RESULT_BYTES,
} from "#typepeek/inspection/model/budget-policy";
import { enforceAnalysisRequestOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";
import type {
  AnalysisRequest,
  InspectionFailure,
  InspectionOutcome,
  InspectionResultByIntent,
} from "#typepeek/inspection/model/protocol";
import {
  ProcessOutputLimitError,
  collectProcessOutput,
} from "#typepeek/platform/process-output";
import {
  processLayer,
  scopedProcess,
} from "#typepeek/platform/process-runtime";
import { decodeJson } from "#typepeek/shared/json-data";

const BUDGET_EXCEEDED = "budget-exceeded";
const LIMIT_EXCEEDED = "limit-exceeded";

export interface AnalysisProcessLimits {
  readonly deadlineMilliseconds: number;
  readonly maxHeapMegabytes: number;
  readonly maxResultBytes: number;
  readonly maxDiagnosticBytes: number;
}

interface AnalysisProcessResult {
  readonly exitCode?: number;
  readonly failed: boolean;
  readonly cacheOutput: Uint8Array;
  readonly isMaxBuffer: boolean;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
  readonly timedOut: boolean;
}

const taggedError = Schema.TaggedError;

class AnalysisProcessExecutionError extends taggedError<
  AnalysisProcessExecutionError,
  {
    readonly brand: unique symbol;
  }
>()("AnalysisProcessExecutionError", { cause: Schema.Defect() }) {}

const PRODUCTION_LIMITS: AnalysisProcessLimits = {
  deadlineMilliseconds: INSPECTION_BUDGET_POLICY.analysisDeadlineMilliseconds,
  maxDiagnosticBytes: 64 * 1024,
  maxHeapMegabytes: INSPECTION_BUDGET_POLICY.analysisHeapMegabytes,
  maxResultBytes: MAX_ANALYSIS_RESULT_BYTES,
};

const MAX_REQUEST_BYTES = 16 * 1024;
const STACK_SIZE_KIBIBYTES = 4096;

const DEADLINE_OUTCOME: InspectionFailure = {
  exceededBudget: "analysis-deadline",
  message: "Inspection exceeded its analysis deadline.",
  reason: BUDGET_EXCEEDED,
  status: LIMIT_EXCEEDED,
};

const MEMORY_OUTCOME: InspectionFailure = {
  exceededBudget: "analysis-memory",
  message: "Inspection exceeded its analysis memory limit.",
  reason: BUDGET_EXCEEDED,
  status: LIMIT_EXCEEDED,
};

const OUTPUT_OUTCOME: InspectionFailure = {
  exceededBudget: "analysis-output-bytes",
  message: "Inspection exceeded its analysis process output limit.",
  reason: BUDGET_EXCEEDED,
  status: LIMIT_EXCEEDED,
};

const TERMINATED_OUTCOME: InspectionFailure = {
  message: "Inspection analysis terminated before completion.",
  reason: "analysis-terminated",
  status: "unsupported",
};

const INVALID_PROCESS_RESULT_OUTCOME: InspectionFailure = {
  message: "Inspection could not validate the analysis process result.",
  reason: "invalid-result",
  status: "unsupported",
};

const executeAnalysisProcess = Effect.fn("executeAnalysisProcess")(
  function* executeAnalysisProcess(
    request: AnalysisRequest,
    entryUrl: URL,
    limits: AnalysisProcessLimits,
    bypassCache: boolean
  ): Effect.fn.Return<AnalysisProcessResult, AnalysisProcessExecutionError> {
    const empty = Buffer.alloc(0);

    const failed = {
      cacheOutput: empty,
      failed: true,
      isMaxBuffer: false,
      stderr: empty,
      stdout: empty,
      timedOut: false,
    };

    const execution = Effect.scoped(
      Effect.gen(function* execution() {
        const entry = yield* Effect.try({
          catch: (cause) => new AnalysisProcessExecutionError({ cause }),
          try: () => fileURLToPath(entryUrl),
        });

        const handle = yield* scopedProcess(
          ChildProcess.make(
            process.execPath,
            [
              `--max-old-space-size=${limits.maxHeapMegabytes}`,
              `--stack-size=${STACK_SIZE_KIBIBYTES}`,
              entry,
            ],
            {
              ...(bypassCache && {
                env: { TYPEPEEK_CACHE_BYPASS: "1" },
                extendEnv: true,
              }),
              additionalFds: { fd3: { type: "output" } },
              forceKillAfter: 100,
              stdin: Stream.make(Buffer.from(JSON.stringify(request))),
            }
          )
        );

        const { exit, stdout, stderr, cacheOutput } = yield* Effect.all(
          {
            cacheOutput: collectProcessOutput(
              handle.getOutputFd(3),
              MAX_CACHE_RECEIPT_BYTES
            ),
            exit: handle.exitCode,
            stderr: collectProcessOutput(
              handle.stderr,
              limits.maxDiagnosticBytes
            ),
            stdout: collectProcessOutput(handle.stdout, limits.maxResultBytes),
          },
          { concurrency: "unbounded" }
        );

        return {
          ...(Exit.isSuccess(exit) && { exitCode: Number(exit.value) }),
          cacheOutput,
          failed:
            Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value !== 0),
          isMaxBuffer: false,
          stderr,
          stdout,
          timedOut: false,
        };
      })
    );

    return yield* execution.pipe(
      Effect.timeoutOrElse({
        duration: limits.deadlineMilliseconds,
        orElse: () => Effect.succeed({ ...failed, timedOut: true }),
      }),
      Effect.catchIf(Schema.is(ProcessOutputLimitError), () =>
        Effect.succeed({ ...failed, isMaxBuffer: true })
      ),
      Effect.mapError((cause) => new AnalysisProcessExecutionError({ cause })),
      Effect.provide(processLayer)
    );
  }
);

const isMemoryFailure = function isMemoryFailure(stderr: Uint8Array): boolean {
  const text = Buffer.from(stderr).toString("utf-8");

  return /heap out of memory|allocation failed - javascript heap/iu.test(text);
};

const analysisProcessFailure = function analysisProcessFailure(
  result: AnalysisProcessResult,
  limits: AnalysisProcessLimits
): InspectionFailure | undefined {
  if (result.timedOut) {
    return DEADLINE_OUTCOME;
  }

  if (result.isMaxBuffer || result.stdout.byteLength > limits.maxResultBytes) {
    return OUTPUT_OUTCOME;
  }

  if (isMemoryFailure(result.stderr)) {
    return MEMORY_OUTCOME;
  }

  return result.failed || result.exitCode !== 0
    ? TERMINATED_OUTCOME
    : undefined;
};

const parseResult = function parseResult(
  serialized: Uint8Array
): Schema.Json | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(serialized);

    return decodeJson(Schema.Json, text);
  } catch {
    return undefined;
  }
};

const shouldRetryInvalidCacheOutcome = function shouldRetryInvalidCacheOutcome(
  allowCacheWrite: boolean,
  bypassCache: boolean,
  cacheHit: ReturnType<typeof readInspectionCacheHitNotice>,
  outcome: InspectionOutcome
): cacheHit is NonNullable<typeof cacheHit> {
  if (!allowCacheWrite) {
    return false;
  }

  if (bypassCache) {
    return false;
  }

  if (cacheHit === undefined) {
    return false;
  }

  if (outcome.status !== "unsupported") {
    return false;
  }

  return outcome.reason === "invalid-result";
};

const runAnalysisProcess = Effect.fn("runAnalysisProcess")(
  function* runAnalysisProcess<Request extends AnalysisRequest>(
    request: Request,
    entryUrl: URL,
    limits: AnalysisProcessLimits,
    forwardProfile: boolean,
    allowCacheWrite = false
  ): Effect.fn.Return<
    InspectionOutcome<InspectionResultByIntent[Request["intent"]]>
  > {
    let bypassCache = false;

    while (true) {
      const result = yield* executeAnalysisProcess(
        request,
        entryUrl,
        limits,
        bypassCache
      ).pipe(
        Effect.catchTag("AnalysisProcessExecutionError", () => Effect.void)
      );

      if (result === undefined) {
        return TERMINATED_OUTCOME;
      }

      const processFailure = analysisProcessFailure(result, limits);

      if (processFailure !== undefined) {
        return processFailure;
      }

      const value = parseResult(result.stdout);

      if (value === undefined) {
        return INVALID_PROCESS_RESULT_OUTCOME;
      }

      const outcome = enforceAnalysisRequestOutcome(request, value);

      const cacheHit = readInspectionCacheHitNotice(
        parseResult(result.cacheOutput)
      );

      if (
        shouldRetryInvalidCacheOutcome(
          allowCacheWrite,
          bypassCache,
          cacheHit,
          outcome
        )
      ) {
        removeInspectionCacheEntry(cacheHit.key);
        bypassCache = true;

        continue;
      }

      if (forwardProfile) {
        forwardInspectionProfile(result.stderr);
      }

      if (allowCacheWrite) {
        writeValidatedInspectionCacheOutcome(
          request,
          outcome,
          parseResult(result.cacheOutput)
        );
      }

      return outcome;
    }
  }
);

const analysisProcessEntryUrl = function analysisProcessEntryUrl(): URL {
  // Node executes TypeScript directly during development. The packed CLI loads
  // the separately emitted process entry from dist/inspection.
  const entryPath = import.meta.url.endsWith(".ts")
    ? "../analysis-process-entry.ts"
    : "./inspection/analysis-process-entry.js";

  return new URL(entryPath, import.meta.url);
};

export const runBoundedAnalysis = Effect.fn("runBoundedAnalysis")(
  function* runBoundedAnalysis<Request extends AnalysisRequest>(
    request: Request
  ): Effect.fn.Return<
    InspectionOutcome<InspectionResultByIntent[Request["intent"]]>
  > {
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
      return {
        exceededBudget: "request-bytes",
        message: "Inspection exceeded its request input limit.",
        reason: BUDGET_EXCEEDED,
        status: LIMIT_EXCEEDED,
      } satisfies InspectionOutcome;
    }

    return yield* runAnalysisProcess(
      request,
      analysisProcessEntryUrl(),
      PRODUCTION_LIMITS,
      inspectionProfilingEnabled,
      true
    );
  }
);

export const analysisProcessNodeArguments =
  function analysisProcessNodeArguments(entrypoint: string): readonly string[] {
    return [
      `--max-old-space-size=${PRODUCTION_LIMITS.maxHeapMegabytes}`,
      `--stack-size=${STACK_SIZE_KIBIBYTES}`,
      entrypoint,
    ];
  };

/** Runs process fixtures with the same isolation as production analysis. */
export const runAnalysisFixtureProcess = Effect.fn("runAnalysisFixtureProcess")(
  function* runAnalysisFixtureProcess(
    request: AnalysisRequest,
    entryUrl: URL,
    limits: AnalysisProcessLimits
  ) {
    return yield* runAnalysisProcess(request, entryUrl, limits, false);
  }
);
