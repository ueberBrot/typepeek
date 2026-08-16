import { execaNode } from "execa";

import {
  forwardInspectionProfile,
  inspectionProfilingEnabled,
} from "#typepeek/inspection/performance-profile";
import {
  enforceDeclarationInspectionOutcome,
  enforceInspectionOutcome,
  enforceInspectionPlanOutcome,
  enforceMemberInspectionOutcome,
  type AnalysisRequest,
  type InspectionOutcome,
} from "#typepeek/inspection/protocol";

export interface AnalysisProcessLimits {
  readonly deadlineMilliseconds: number;
  readonly maxHeapMegabytes: number;
  readonly maxResultBytes: number;
  readonly maxDiagnosticBytes: number;
}

const PRODUCTION_LIMITS: AnalysisProcessLimits = {
  deadlineMilliseconds: 10_000,
  maxHeapMegabytes: 128,
  maxResultBytes: 64 * 1_024,
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
export async function runBoundedAnalysis(request: AnalysisRequest): Promise<InspectionOutcome> {
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
    return {
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget: "request-bytes",
      message: "Inspection exceeded its request input limit.",
    };
  }
  return runProcess(
    request,
    analysisProcessEntryUrl(),
    PRODUCTION_LIMITS,
    inspectionProfilingEnabled,
  );
}

/** Exact trusted Node arguments shared with static-inspection adapters. */
export function analysisProcessNodeArguments(entrypoint: string): readonly string[] {
  return [
    `--max-old-space-size=${PRODUCTION_LIMITS.maxHeapMegabytes}`,
    `--stack-size=${STACK_SIZE_KIBIBYTES}`,
    entrypoint,
  ];
}

/** Injectable adapter for hostile process-protocol fixtures only. */
export async function runAnalysisFixtureProcess(
  request: AnalysisRequest,
  entryUrl: URL,
  limits: AnalysisProcessLimits,
): Promise<InspectionOutcome> {
  return runProcess(request, entryUrl, limits, false);
}

/**
 * Requires a clean exit behind wall-clock, heap, diagnostics, and byte-framed
 * result limits before allowing one result to cross the process seam.
 */
async function runProcess(
  request: AnalysisRequest,
  entryUrl: URL,
  limits: AnalysisProcessLimits,
  forwardProfile: boolean,
): Promise<InspectionOutcome> {
  const result = await execaNode(entryUrl, [], {
    ipcInput: request,
    serialization: "advanced",
    timeout: limits.deadlineMilliseconds,
    forceKillAfterDelay: 100,
    nodeOptions: [
      `--max-old-space-size=${limits.maxHeapMegabytes}`,
      `--stack-size=${STACK_SIZE_KIBIBYTES}`,
    ],
    maxBuffer: {
      stdout: limits.maxResultBytes,
      stderr: limits.maxDiagnosticBytes,
    },
    encoding: "buffer",
    reject: false,
  });

  if (result.timedOut) {
    return DEADLINE_OUTCOME;
  }
  if (result.isMaxBuffer) {
    return OUTPUT_OUTCOME;
  }
  if (isMemoryFailure(result.stderr)) {
    return MEMORY_OUTCOME;
  }
  if (result.failed || result.exitCode !== 0) {
    return TERMINATED_OUTCOME;
  }
  if (forwardProfile) {
    forwardInspectionProfile(result.stderr);
  }
  const resultBytes = result.stdout.byteLength;
  if (resultBytes > limits.maxResultBytes) {
    return OUTPUT_OUTCOME;
  }
  const value = parseResult(result.stdout);
  if (value === undefined) {
    return INVALID_PROCESS_RESULT_OUTCOME;
  }

  return enforceAnalysisOutcome(request, value);
}

function enforceAnalysisOutcome(request: AnalysisRequest, value: unknown): InspectionOutcome {
  if (request.intent === "inspection-plan") {
    return enforceInspectionPlanOutcome(request.request, value);
  }
  if (request.intent === "declaration-inspection") {
    return enforceDeclarationInspectionOutcome(request.request, value);
  }
  if (request.intent === "member-inspection") {
    return enforceMemberInspectionOutcome(request.request, value);
  }
  return enforceInspectionOutcome(request.intent, value);
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
