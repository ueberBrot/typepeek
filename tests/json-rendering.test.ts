import { expect, it } from "vite-plus/test";

import { renderJsonOutcome } from "#typepeek/json-rendering";

it("escapes terminal controls without changing parsed outcome values", () => {
  const outcome = {
    status: "unsupported",
    message: "line\n\u001B[31m\u061C\u202E",
  } as const;

  const rendering = renderJsonOutcome(outcome);

  expect(rendering.failed).toBe(true);
  expect(rendering.text).not.toContain("\u001B");
  expect(rendering.text).not.toContain("\u061C");
  expect(rendering.text).not.toContain("\u202E");
  expect(JSON.parse(rendering.text)).toEqual(outcome);
});

it("returns one complete failure when escaping exceeds the JSON adapter bound", () => {
  const rendering = renderJsonOutcome({
    status: "unsupported",
    message: "\0".repeat(30_000),
  });

  expect(rendering).toEqual({
    failed: true,
    text: JSON.stringify({
      status: "limit-exceeded",
      message: "Inspection exceeded its JSON output limit.",
    }),
  });
});
