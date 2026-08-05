import { parentPort, workerData } from "node:worker_threads";

import { analyzeInterfaceOverview } from "#typepeek/inspection/analyze";
import type { InterfaceOverviewRequest } from "#typepeek/inspection/protocol";

parentPort?.postMessage(analyzeInterfaceOverview(workerData as InterfaceOverviewRequest));
