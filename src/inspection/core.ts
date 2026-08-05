import { Worker } from "node:worker_threads";

import {
  enforceInspectionOutcome,
  readInterfaceOverviewRequest,
  type InspectionOutcome,
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
): Promise<InspectionOutcome> {
  const requestReading = readInterfaceOverviewRequest(request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  const worker = new Worker(getAnalysisWorkerUrl(), {
    workerData: requestReading.request,
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      stackSizeMb: 4,
    },
  });
  const outcome = await waitForWorker(worker);
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

function waitForWorker(worker: Worker): Promise<InspectionOutcome> {
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

    worker.once("message", (value: unknown) => finish(readWorkerMessage(value)));
    worker.once("error", (error) => finish(workerErrorOutcome(error)));
    worker.once("exit", (exitCode) => {
      if (!settled && exitCode !== 0) {
        finish(TERMINATED_OUTCOME);
      }
    });
  });
}

function readWorkerMessage(value: unknown): InspectionOutcome {
  const resultBytes = serializedByteLength(value);
  if (resultBytes === undefined) {
    return enforceInspectionOutcome(undefined);
  }
  if (resultBytes > MAX_RESULT_BYTES) {
    return {
      status: "limit-exceeded",
      message: "Inspection exceeded its output limit.",
    };
  }

  return enforceInspectionOutcome(value);
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
