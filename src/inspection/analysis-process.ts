import { spawnSync } from "node:child_process";
import nodePath from "node:path";

import { Effect, Schema } from "effect";
import { execaNode } from "execa";

import {
  INSPECTION_BUDGET_POLICY,
  MAX_ANALYSIS_RESULT_BYTES,
} from "#typepeek/inspection/budget-policy";
import { removeInspectionCacheEntry } from "#typepeek/inspection/inspection-cache-files";
import {
  readInspectionCacheHitNotice,
  writeValidatedInspectionCacheOutcome,
} from "#typepeek/inspection/inspection-cache-storage";
import { enforceAnalysisRequestOutcome } from "#typepeek/inspection/inspection-outcome-authority";
import {
  forwardInspectionProfile,
  inspectionProfilingEnabled,
} from "#typepeek/inspection/performance-profile";
import type {
  AnalysisRequest,
  InspectionFailure,
  InspectionOutcome,
  InspectionResultByIntent,
} from "#typepeek/inspection/protocol";
import { decodeJson } from "#typepeek/json-data";

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
  readonly ipcOutput: readonly unknown[];
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

const executeAnalysisProcess = function executeAnalysisProcess(
  request: AnalysisRequest,
  entryUrl: URL,
  limits: AnalysisProcessLimits,
  bypassCache: boolean
): Effect.Effect<AnalysisProcessResult, AnalysisProcessExecutionError> {
  return Effect.callback<AnalysisProcessResult, AnalysisProcessExecutionError>(
    (resume, cancelSignal) => {
      try {
        let timedOut = false;

        const subprocess = execaNode(entryUrl, [], {
          ipcInput: request,
          ...(bypassCache && { env: { TYPEPEEK_CACHE_BYPASS: "1" } }),
          detached: process.platform !== "win32",
          encoding: "buffer",
          forceKillAfterDelay: 100,
          maxBuffer: {
            ipc: 1,
            stderr: limits.maxDiagnosticBytes,
            stdout: limits.maxResultBytes,
          },
          nodeOptions: [
            `--max-old-space-size=${limits.maxHeapMegabytes}`,
            `--stack-size=${STACK_SIZE_KIBIBYTES}`,
          ],
          reject: false,
          serialization: "advanced",
        });

        const terminate = (): void => {
          if (process.platform === "win32" && subprocess.pid !== undefined) {
            // Kill the tree before the worker disappears: taskkill cannot find
            // native descendants through a parent that has already exited.
            spawnSync(
              nodePath.join(
                process.env["SystemRoot"] ?? "C:\\Windows",
                "System32",
                "taskkill.exe"
              ),
              ["/PID", String(subprocess.pid), "/T", "/F"],
              { stdio: "ignore", timeout: 1000 }
            );
          }

          subprocess.kill();
        };

        const deadline = setTimeout(() => {
          timedOut = true;
          terminate();
        }, limits.deadlineMilliseconds);

        const onCancel = (): void => {
          terminate();
        };

        cancelSignal.addEventListener("abort", onCancel, { once: true });

        subprocess.nodeChildProcess.once("exit", () => {
          clearTimeout(deadline);
          cancelSignal.removeEventListener("abort", onCancel);

          if (process.platform !== "win32" && subprocess.pid !== undefined) {
            try {
              process.kill(-subprocess.pid, "SIGKILL");
            } catch {
              // The process group is already empty after ordinary SDK cleanup.
            }
          }
        });

        if (cancelSignal.aborted) {
          terminate();
        }

        const forwardResult = async (): Promise<void> => {
          try {
            const result = await subprocess;
            resume(
              Effect.succeed({
                ...(result.exitCode !== undefined && {
                  exitCode: result.exitCode,
                }),
                failed: result.failed,
                ipcOutput: result.ipcOutput,
                isMaxBuffer: result.isMaxBuffer,
                stderr: result.stderr,
                stdout: result.stdout,
                timedOut,
              })
            );
          } catch (error) {
            resume(
              Effect.fail(new AnalysisProcessExecutionError({ cause: error }))
            );
          } finally {
            clearTimeout(deadline);
            cancelSignal.removeEventListener("abort", onCancel);
          }
        };

        void forwardResult();

        return Effect.promise(async () => {
          try {
            await subprocess;
          } catch {
            // The forwarding task reports the subprocess failure through resume.
          }
        });
      } catch (error) {
        resume(
          Effect.fail(new AnalysisProcessExecutionError({ cause: error }))
        );

        return Effect.void;
      }
    }
  );
};

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

const analysisLifecycle = {
  finalizeAnalysisProcessOutcome: Effect.fn("finalizeAnalysisProcessOutcome")(
    function* finalizeAnalysisProcessOutcome<Request extends AnalysisRequest>({
      allowCacheWrite,
      bypassCache,
      entryUrl,
      forwardProfile,
      limits,
      outcome,
      request,
      result,
    }: AnalysisProcessCompletion<Request>): Effect.fn.Return<
      InspectionOutcome<InspectionResultByIntent[Request["intent"]]>
    > {
      const cacheHit = readInspectionCacheHitNotice(result.ipcOutput[0]);

      if (
        shouldRetryInvalidCacheOutcome(
          allowCacheWrite,
          bypassCache,
          cacheHit,
          outcome
        )
      ) {
        removeInspectionCacheEntry(cacheHit.key);

        return yield* analysisLifecycle.runAnalysisProcess(
          request,
          entryUrl,
          limits,
          forwardProfile,
          allowCacheWrite,
          true
        );
      }

      if (forwardProfile) {
        forwardInspectionProfile(result.stderr);
      }

      if (allowCacheWrite) {
        writeValidatedInspectionCacheOutcome(
          request,
          outcome,
          result.ipcOutput[0]
        );
      }

      return outcome;
    }
  ),
  runAnalysisProcess: Effect.fn("runAnalysisProcess")(
    function* runAnalysisProcess<Request extends AnalysisRequest>(
      request: Request,
      entryUrl: URL,
      limits: AnalysisProcessLimits,
      forwardProfile: boolean,
      allowCacheWrite = false,
      bypassCache = false
    ): Effect.fn.Return<
      InspectionOutcome<InspectionResultByIntent[Request["intent"]]>
    > {
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

      return yield* analysisLifecycle.finalizeAnalysisProcessOutcome({
        allowCacheWrite,
        bypassCache,
        entryUrl,
        forwardProfile,
        limits,
        outcome,
        request,
        result,
      });
    }
  ),
};

const analysisProcessEntryUrl = function analysisProcessEntryUrl(): URL {
  // Node executes TypeScript directly during development. The packed CLI loads
  // the separately emitted process entry from dist/inspection.
  const entryPath = import.meta.url.endsWith(".ts")
    ? "./analysis-process-entry.ts"
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

    return yield* analysisLifecycle.runAnalysisProcess(
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
    return yield* analysisLifecycle.runAnalysisProcess(
      request,
      entryUrl,
      limits,
      false
    );
  }
);

interface AnalysisProcessCompletion<Request extends AnalysisRequest> {
  readonly allowCacheWrite: boolean;
  readonly bypassCache: boolean;
  readonly entryUrl: URL;
  readonly forwardProfile: boolean;
  readonly limits: AnalysisProcessLimits;
  readonly outcome: InspectionOutcome<
    InspectionResultByIntent[Request["intent"]]
  >;
  readonly request: Request;
  readonly result: AnalysisProcessResult;
}
