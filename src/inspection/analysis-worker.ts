import { parentPort, workerData } from "node:worker_threads";

import { analyzeInspection } from "#typepeek/inspection/analyze";
import { readAnalysisRequest } from "#typepeek/inspection/protocol";

// Revalidate the structured-cloned payload at the worker seam. The worker must
// not rely on the caller having used the Inspection Core interface.
const requestReading = readAnalysisRequest(workerData);
parentPort?.postMessage(
  requestReading.accepted ? analyzeInspection(requestReading.request) : requestReading.outcome,
);
