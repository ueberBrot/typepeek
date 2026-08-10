import { getOneMessage } from "execa";

import { analyzeInspection } from "#typepeek/inspection/analyze";
import { readAnalysisRequest } from "#typepeek/inspection/protocol";

// Revalidate the structured-cloned payload at the subprocess seam. The entry
// must not rely on the caller having used the Inspection Core interface.
const requestReading = readAnalysisRequest(await getOneMessage());
process.stdout.write(
  JSON.stringify(
    requestReading.accepted ? analyzeInspection(requestReading.request) : requestReading.outcome,
  ),
);
