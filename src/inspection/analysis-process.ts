import { Effect } from "effect";
import { execaNode } from "execa";

import { MAX_ANALYSIS_RESULT_BYTES } from "#typepeek/inspection/budget-policy";
import {
  readInspectionCacheHitNotice,
  removeInspectionCacheEntry,
  writeValidatedInspectionCacheOutcome,
} from "#typepeek/inspection/inspection-cache";
import {
  forwardInspectionProfile,
  inspectionProfilingEnabled,
} from "#typepeek/inspection/performance-profile";
import {
  enforceAnalysisRequestOutcome,
  type AnalysisRequest,
  type InspectionOutcome,
} from "#typepeek/inspection/protocol";

interface AnalysisProcessLimits {
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

const PRODUCTION_LIMITS: AnalysisProcessLimits = {
  deadlineMilliseconds: 10_000,
  maxHeapMegabytes: 128,
  maxResultBytes: MAX_ANALYSIS_RESULT_BYTES,
  maxDiagnosticBytes: 64 * 1_024,
};
const MAX_REQUEST_BYTES = 16 * 1_024;
const STACK_SIZE_KIBIBYTES = 4_096;

const DEADLINE_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  reason: "budget-exceeded",
  exceededBudget: "analysis-deadline",
  message: "Inspection exceeded its analysis deadline.",
};
const MEMORY_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  reason: "budget-exceeded",
  exceededBudget: "analysis-memory",
  message: "Inspection exceeded its analysis memory limit.",
};
const OUTPUT_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  reason: "budget-exceeded",
  exceededBudget: "analysis-output-bytes",
  message: "Inspection exceeded its analysis process output limit.",
};
const TERMINATED_OUTCOME: InspectionOutcome = {
  status: "unsupported",
  reason: "analysis-terminated",
  message: "Inspection analysis terminated before completion.",
};
const INVALID_PROCESS_RESULT_OUTCOME: InspectionOutcome = {
  status: "unsupported",
  reason: "invalid-result",
  message: "Inspection could not validate the analysis process result.",
};

/** Runs one production analysis behind this module's complete isolation policy. */
export const runBoundedAnalysis = Effect.fn("runBoundedAnalysis")(function* (
  request: AnalysisRequest,
) {
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
    return {
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget: "request-bytes",
      message: "Inspection exceeded its request input limit.",
    } satisfies InspectionOutcome;
  }
  return yield* runAnalysisProcess(
    request,
    analysisProcessEntryUrl(),
    PRODUCTION_LIMITS,
    inspectionProfilingEnabled,
    true,
  );
});

/** Exact trusted Node arguments shared with static-inspection adapters. */
export function analysisProcessNodeArguments(entrypoint: string): readonly string[] {
  return [
    `--max-old-space-size=${PRODUCTION_LIMITS.maxHeapMegabytes}`,
    `--stack-size=${STACK_SIZE_KIBIBYTES}`,
    entrypoint,
  ];
}

/** Runs hostile process-protocol fixtures through the production isolation implementation. */
export const runAnalysisFixtureProcess = Effect.fn("runAnalysisFixtureProcess")(function* (
  request: AnalysisRequest,
  entryUrl: URL,
  limits: AnalysisProcessLimits,
) {
  return yield* runAnalysisProcess(request, entryUrl, limits, false);
});

/**
 * Requires a clean exit behind wall-clock, heap, diagnostics, and byte-framed
 * result limits before allowing one result to cross the process seam.
 */
const runAnalysisProcess = Effect.fn("runAnalysisProcess")(function* (
  request: AnalysisRequest,
  entryUrl: URL,
  limits: AnalysisProcessLimits,
  forwardProfile: boolean,
  allowCacheWrite = false,
  bypassCache = false,
): Effect.fn.Return<InspectionOutcome> {
  const result = yield* Effect.callback<AnalysisProcessResult>((resume, cancelSignal) => {
    const subprocess = execaNode(entryUrl, [], {
      ipcInput: request,
      ...(bypassCache ? { env: { TYPEPEEK_CACHE_BYPASS: "1" } } : {}),
      serialization: "advanced",
      timeout: limits.deadlineMilliseconds,
      forceKillAfterDelay: 100,
      cancelSignal,
      nodeOptions: [
        `--max-old-space-size=${limits.maxHeapMegabytes}`,
        `--stack-size=${STACK_SIZE_KIBIBYTES}`,
      ],
      maxBuffer: {
        ipc: 1,
        stdout: limits.maxResultBytes,
        stderr: limits.maxDiagnosticBytes,
      },
      encoding: "buffer",
      reject: false,
    });
    void subprocess.then(
      (result) => resume(Effect.succeed(result)),
      (error) => resume(Effect.die(error)),
    );
    return Effect.promise(() =>
      subprocess.then(
        () => undefined,
        () => undefined,
      ),
    );
  });
  const processFailure = analysisProcessFailure(result, limits);
  if (processFailure !== undefined) {
    return processFailure;
  }
  const value = parseResult(result.stdout);
  if (value === undefined) {
    return INVALID_PROCESS_RESULT_OUTCOME;
  }
  const outcome = enforceAnalysisRequestOutcome(request, value);
  return yield* finalizeAnalysisProcessOutcome({
    allowCacheWrite,
    bypassCache,
    entryUrl,
    forwardProfile,
    limits,
    outcome,
    request,
    result,
  });
});

function analysisProcessFailure(
  result: AnalysisProcessResult,
  limits: AnalysisProcessLimits,
): InspectionOutcome | undefined {
  if (result.timedOut) return DEADLINE_OUTCOME;
  if (result.isMaxBuffer || result.stdout.byteLength > limits.maxResultBytes) {
    return OUTPUT_OUTCOME;
  }
  if (isMemoryFailure(result.stderr)) return MEMORY_OUTCOME;
  return result.failed || result.exitCode !== 0 ? TERMINATED_OUTCOME : undefined;
}

interface AnalysisProcessCompletion {
  readonly allowCacheWrite: boolean;
  readonly bypassCache: boolean;
  readonly entryUrl: URL;
  readonly forwardProfile: boolean;
  readonly limits: AnalysisProcessLimits;
  readonly outcome: InspectionOutcome;
  readonly request: AnalysisRequest;
  readonly result: AnalysisProcessResult;
}

const finalizeAnalysisProcessOutcome = Effect.fn("finalizeAnalysisProcessOutcome")(function* ({
  allowCacheWrite,
  bypassCache,
  entryUrl,
  forwardProfile,
  limits,
  outcome,
  request,
  result,
}: AnalysisProcessCompletion): Effect.fn.Return<InspectionOutcome> {
  const cacheHit = readInspectionCacheHitNotice(result.ipcOutput[0]);
  if (shouldRetryInvalidCacheOutcome(allowCacheWrite, bypassCache, cacheHit, outcome)) {
    removeInspectionCacheEntry(cacheHit.key);
    return yield* runAnalysisProcess(
      request,
      entryUrl,
      limits,
      forwardProfile,
      allowCacheWrite,
      true,
    );
  }
  if (forwardProfile) {
    forwardInspectionProfile(result.stderr);
  }
  if (allowCacheWrite) {
    writeValidatedInspectionCacheOutcome(request, outcome, result.ipcOutput[0]);
  }
  return outcome;
});

function shouldRetryInvalidCacheOutcome(
  allowCacheWrite: boolean,
  bypassCache: boolean,
  cacheHit: ReturnType<typeof readInspectionCacheHitNotice>,
  outcome: InspectionOutcome,
): cacheHit is NonNullable<typeof cacheHit> {
  return (
    allowCacheWrite &&
    !bypassCache &&
    cacheHit !== undefined &&
    outcome.status === "unsupported" &&
    outcome.reason === "invalid-result"
  );
}

function analysisProcessEntryUrl(): URL {
  // Node executes TypeScript directly during development. The packed CLI loads
  // the separately emitted process entry from dist/inspection.
  const entryPath = import.meta.url.endsWith(".ts")
    ? "./analysis-process-entry.ts"
    : "./inspection/analysis-process-entry.js";
  return new URL(entryPath, import.meta.url);
}

function isMemoryFailure(stderr: Uint8Array): boolean {
  const text = Buffer.from(stderr).toString("utf8");
  return /heap out of memory|allocation failed - javascript heap/i.test(text);
}

function parseResult(serialized: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(serialized);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
