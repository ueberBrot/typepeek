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

const ANALYSIS_DEADLINE_MS = 5_000;
const MAX_RESULT_BYTES = 64 * 1_024;

const DEADLINE_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  message: "Inspection exceeded its analysis deadline.",
};
const TERMINATED_OUTCOME: InspectionOutcome = {
  status: "limit-exceeded",
  message: "Inspection analysis terminated before completion.",
};

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
