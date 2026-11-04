import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";
import { renderJsonOutcome } from "#typepeek/json-rendering";

describe("json-rendering", () => {
  it("escapes terminal controls without changing parsed outcome values", () => {
    const outcome = {
      message: "line\n\u001B[31m\u061C\u202E",
      reason: "unsupported-evidence",
      status: "unsupported",
    } as const;

    const rendering = renderJsonOutcome(outcome);
    expect([
      rendering.failed,
      rendering.text.includes("\u001B"),
      rendering.text.includes("\u061C"),
      rendering.text.includes("\u202E"),
      decodeJson(Schema.MutableJson, rendering.text),
    ]).toStrictEqual([true, false, false, false, outcome]);
  });

  it("returns one complete failure when escaping exceeds the JSON adapter bound", () => {
    const rendering = renderJsonOutcome({
      message: "\0".repeat(30_000),
      reason: "unsupported-evidence",
      status: "unsupported",
    });

    expect(rendering).toStrictEqual({
      failed: true,
      text: JSON.stringify({
        exceededBudget: "json-output",
        message: "Inspection exceeded its JSON output limit.",
        reason: "budget-exceeded",
        status: "limit-exceeded",
      }),
    });
  });
});
