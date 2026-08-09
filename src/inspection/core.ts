import { Worker } from "node:worker_threads";

import {
  enforceInspectionOutcome,
  readInspectionRequest,
  type AnalysisRequest,
  type ExportInspection,
  type ExportInspectionRequest,
  type InspectionOutcome,
  type InterfaceOverview,
  type InterfaceOverviewRequest,
} from "#typepeek/inspection/protocol";

const ANALYSIS_DEADLINE_MS = 10_000;
const MAX_RESULT_BYTES = 64 * 1_024;

const DEADLINE_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  message: "Inspection exceeded its analysis deadline.",
};
const TERMINATED_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  message: "Inspection analysis terminated before completion.",
};

/**
 * Validates a request and produces a bounded index of the Module Exports visible
 * from its Resolution Context. Analysis runs in an isolated worker, and its
 * result is size- and schema-checked before it crosses the Inspection Core seam.
 */
export async function inspectInterfaceOverview(
  request: InterfaceOverviewRequest,
): Promise<InspectionOutcome<InterfaceOverview>> {
  const requestReading = readInspectionRequest("interface-overview", request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  return enforceInspectionOutcome(
    "interface-overview",
    await runAnalysis({
      intent: "interface-overview",
      request: requestReading.request,
    }),
  );
}

/**
 * Validates a request and produces a bounded Export Inspection for one Module
 * Export. Missing exports and all supported failure modes are returned as
 * structured outcomes rather than partial Inspection Results.
 */
export async function inspectExport(
  request: ExportInspectionRequest,
): Promise<InspectionOutcome<ExportInspection>> {
  const requestReading = readInspectionRequest("export-inspection", request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  return enforceInspectionOutcome(
    "export-inspection",
    await runAnalysis({
      intent: "export-inspection",
      request: requestReading.request,
    }),
  );
}

async function runAnalysis(request: AnalysisRequest): Promise<InspectionOutcome> {
  // The worker is an isolation mechanism: wall-clock, heap, stack, and result
  // size are bounded independently of the analyzer's internal traversal limits.
  const worker = new Worker(getAnalysisWorkerUrl(), {
    workerData: request,
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      stackSizeMb: 4,
    },
  });
  const outcome = await waitForWorker(worker, request.intent);
  void worker.terminate();
  return outcome;
}

function getAnalysisWorkerUrl(): URL {
  // Node executes the TypeScript worker directly during development, while the
  // packed CLI loads the separately emitted worker from dist/inspection.
  const workerPath = import.meta.url.endsWith(".ts")
    ? "./analysis-worker.ts"
    : "./inspection/analysis-worker.js";
  return new URL(workerPath, import.meta.url);
}

function waitForWorker(
  worker: Worker,
  intent: AnalysisRequest["intent"],
): Promise<InspectionOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const deadline = setTimeout(() => finish(DEADLINE_OUTCOME), ANALYSIS_DEADLINE_MS);
    const finish = (outcome: InspectionOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };

    worker.once("message", (value: unknown) => finish(readWorkerMessage(value, intent)));
    worker.once("error", (error) => finish(workerErrorOutcome(error)));
    worker.once("exit", (exitCode) => {
      if (!settled && exitCode !== 0) {
        finish(TERMINATED_OUTCOME);
      }
    });
  });
}

function readWorkerMessage(value: unknown, intent: AnalysisRequest["intent"]): InspectionOutcome {
  // Enforce the transport budget before accepting the worker's protocol shape.
  // A valid but oversized result must never be mistaken for authoritative output.
  const resultBytes = serializedByteLength(value);
  if (resultBytes === undefined) {
    return enforceInspectionOutcome(intent, undefined);
  }
  if (resultBytes > MAX_RESULT_BYTES) {
    return {
      status: "limit-exceeded",
      message: "Inspection exceeded its output limit.",
    };
  }

  return enforceInspectionOutcome(intent, value);
}

function workerErrorOutcome(error: Error): InspectionOutcome {
  if ("code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY") {
    return {
      status: "limit-exceeded",
      message: "Inspection exceeded its analysis memory limit.",
    };
  }

  return {
    status: "unsupported",
    message: "Inspection could not analyze the installed declarations.",
  };
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized);
  } catch {
    return undefined;
  }
}
