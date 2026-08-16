import { getOneMessage } from "execa";

import { analyzeInspection } from "#typepeek/inspection/analyze";
import {
  beginInspectionProfile,
  completeInspectionProfile,
  profileInspectionPhase,
} from "#typepeek/inspection/performance-profile";
import { readAnalysisRequest } from "#typepeek/inspection/protocol";

// Revalidate the structured-cloned payload at the subprocess seam. The entry
// must not rely on the caller having used the Inspection Core interface.
beginInspectionProfile();
const message = await getOneMessage();
const requestReading = profileInspectionPhase("request-validation", () =>
  readAnalysisRequest(message),
);
const outcome = requestReading.accepted
  ? profileInspectionPhase("analysis", () => analyzeInspection(requestReading.request))
  : requestReading.outcome;
process.stdout.write(JSON.stringify(outcome));
const profile = completeInspectionProfile();
if (profile !== undefined) {
  process.stderr.write(`${JSON.stringify(profile)}\n`);
}
