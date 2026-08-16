import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { serializeTerminalSafeJson } from "#typepeek/output-safety";

const MAX_JSON_OUTPUT_BYTES = 128 * 1_024;
const JSON_OUTPUT_LIMIT_FAILURE = {
  status: "limit-exceeded",
  reason: "budget-exceeded",
  exceededBudget: "json-output",
  message: "Inspection exceeded its JSON output limit.",
} as const satisfies InspectionOutcome;

export interface JsonOutcomeRendering {
  readonly failed: boolean;
  readonly text: string;
}

/** Serializes one complete outcome without allowing terminal control semantics. */
export function renderJsonOutcome(outcome: InspectionOutcome): JsonOutcomeRendering {
  const text = serializeTerminalSafeJson(outcome);
  if (Buffer.byteLength(text) > MAX_JSON_OUTPUT_BYTES) {
    return { failed: true, text: serializeTerminalSafeJson(JSON_OUTPUT_LIMIT_FAILURE) };
  }
  return { failed: outcome.status !== "success", text };
}
