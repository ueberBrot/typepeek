import { getOneMessage, sendMessage } from "execa";

import { analyzeInspection } from "#typepeek/inspection/analyze";
import { encodeInspectionCacheWriteReceipt } from "#typepeek/inspection/inspection-cache-codec";
import {
  beginInspectionProfile,
  completeInspectionProfile,
  profileInspectionPhase,
} from "#typepeek/inspection/performance-profile";
import { readAnalysisRequest } from "#typepeek/inspection/request-definitions";

// Validate subprocess input even when the caller bypasses Inspection Core.
beginInspectionProfile();
const message = await getOneMessage();
const requestReading = profileInspectionPhase("request-validation", () =>
  readAnalysisRequest(message),
);
const execution = requestReading.accepted
  ? profileInspectionPhase("analysis", () =>
      analyzeInspection(requestReading.request, process.env["TYPEPEEK_CACHE_BYPASS"] !== "1"),
    )
  : { outcome: requestReading.outcome };
const { cacheMessage } = execution;
if (cacheMessage !== undefined) {
  const encoded =
    cacheMessage.kind === "inspection-cache-write"
      ? encodeInspectionCacheWriteReceipt(cacheMessage)
      : cacheMessage;
  if (encoded !== undefined) await sendMessage(encoded);
}
const { outcome } = execution;
process.stdout.write(JSON.stringify(outcome));
const profile = completeInspectionProfile();
if (profile !== undefined) {
  process.stderr.write(`${JSON.stringify(profile)}\n`);
}
