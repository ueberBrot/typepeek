import { parentPort, workerData } from "node:worker_threads";

import { analyzeInspection } from "#typepeek/inspection/analyze";
import { readAnalysisRequest } from "#typepeek/inspection/protocol";

const requestReading = readAnalysisRequest(workerData);
parentPort?.postMessage(
  requestReading.accepted ? analyzeInspection(requestReading.request) : requestReading.outcome,
);
