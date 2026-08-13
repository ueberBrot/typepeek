import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { isUnsafeOutputCodePoint } from "#typepeek/output-safety";

const MAX_JSON_OUTPUT_BYTES = 128 * 1_024;
const JSON_OUTPUT_LIMIT_FAILURE = {
  status: "limit-exceeded",
  message: "Inspection exceeded its JSON output limit.",
} as const satisfies InspectionOutcome;

export interface JsonOutcomeRendering {
  readonly failed: boolean;
  readonly text: string;
}

/** Serializes one complete outcome without allowing terminal control semantics. */
export function renderJsonOutcome(outcome: InspectionOutcome): JsonOutcomeRendering {
  const text = serializeJson(outcome);
  if (Buffer.byteLength(text) > MAX_JSON_OUTPUT_BYTES) {
    return { failed: true, text: serializeJson(JSON_OUTPUT_LIMIT_FAILURE) };
  }
  return { failed: outcome.status !== "success", text };
}

function serializeJson(value: InspectionOutcome): string {
  return Array.from(JSON.stringify(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isUnsafeOutputCodePoint(codePoint) ? jsonUnicodeEscape(codePoint) : character;
  }).join("");
}

function jsonUnicodeEscape(codePoint: number): string {
  return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}
