import { parentPort, workerData } from "node:worker_threads";

import { analyzeInterfaceOverview } from "#typepeek/inspection/analyze";
import { readInterfaceOverviewRequest } from "#typepeek/inspection/protocol";

const requestReading = readInterfaceOverviewRequest(workerData);
parentPort?.postMessage(
  requestReading.accepted
    ? analyzeInterfaceOverview(requestReading.request)
    : requestReading.outcome,
);
