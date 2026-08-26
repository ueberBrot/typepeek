import { getOneMessage, sendMessage } from "execa";

import { analyzeInspectionWithCache } from "#typepeek/inspection/analyze";
import {
  beginInspectionProfile,
  completeInspectionProfile,
  profileInspectionPhase,
} from "#typepeek/inspection/performance-profile";
import { readAnalysisRequest } from "#typepeek/inspection/request-definitions";

// Revalidate the structured-cloned payload at the subprocess seam. The entry
// must not rely on the caller having used the Inspection Core interface.
beginInspectionProfile();
const message = await getOneMessage();
const requestReading = profileInspectionPhase("request-validation", () =>
  readAnalysisRequest(message),
);
const execution = requestReading.accepted
  ? profileInspectionPhase("analysis", () =>
      analyzeInspectionWithCache(
        requestReading.request,
        process.env["TYPEPEEK_CACHE_BYPASS"] !== "1",
      ),
    )
  : { outcome: requestReading.outcome };
const cacheMessage = execution.cacheWrite ?? execution.cacheHit;
if (cacheMessage !== undefined) {
  await sendMessage(cacheMessage);
}
const { outcome } = execution;
process.stdout.write(JSON.stringify(outcome));
const profile = completeInspectionProfile();
if (profile !== undefined) {
  process.stderr.write(`${JSON.stringify(profile)}\n`);
}
