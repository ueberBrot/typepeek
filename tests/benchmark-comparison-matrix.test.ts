import { describe, expect, it } from "vite-plus/test";

import type { ComparisonObservation } from "../benchmarks/codex-discovery/comparison-matrix.ts";
import { summarizeComparisonMatrix } from "../benchmarks/codex-discovery/comparison-matrix.ts";

const observation = (
  condition: ComparisonObservation["condition"],
  taskSeconds: number,
  reportedTokens: number,
  repeat = 0
): ComparisonObservation => ({
  artifactDirectory: "/unused",
  classification: "task",
  condition,
  effort: "low",
  finalAnswer: { passed: true },
  model: "gpt-6.1-sol",
  passed: true,
  repeat,
  task: "example",
  telemetry: {
    inputTokens: reportedTokens,
    outputTokens: 0,
    usageComplete: true,
  },
  timing: {
    commandSeconds: null,
    outsideToolsSeconds: taskSeconds / 2,
    reason: null,
    taskSeconds,
    toolCalls: 1,
    toolSeconds: taskSeconds / 2,
  },
});

describe("benchmark comparison matrix", () => {
  it("uses identical successful pairs while retaining failures in usage totals", () => {
    const matrix = summarizeComparisonMatrix(
      [
        observation("files", 20, 1000),
        observation("typepeek-skill", 10, 400),
        observation("files", 100, 9000, 1),
        { ...observation("typepeek-skill", 1, 100, 1), passed: false },
      ],
      ["example"]
    );

    expect(matrix.overall).toMatchObject({
      files: { attempts: 2, reportedTokens: 10_000, successful: 2 },
      pairs: 1,
      taskTime: { files: 20, savedPercent: 50, typepeek: 10 },
      tokens: { files: 1000, savedPercent: 60, typepeek: 400 },
      toolTime: { files: 10, savedPercent: 50, typepeek: 5 },
      typepeek: { attempts: 2, reportedTokens: 500, successful: 1 },
    });
  });

  it("keeps missing timing and partial usage unknown", () => {
    const partial = observation("typepeek-skill", 10, 400);
    const withoutTiming = { ...partial };
    delete withoutTiming.timing;

    const matrix = summarizeComparisonMatrix(
      [
        observation("files", 20, 1000),
        {
          ...withoutTiming,
          telemetry: { ...partial.telemetry, usageComplete: false },
        },
      ],
      ["example"]
    );

    expect(matrix.overall).toMatchObject({
      taskTime: { files: null, knownPairs: 0, savedPercent: null },
      tokens: { files: null, knownPairs: 0, savedPercent: null },
      typepeek: { reportedTokens: null, usageComplete: false },
    });
  });

  it("requires a correct final answer for a successful task comparison", () => {
    const matrix = summarizeComparisonMatrix(
      [
        observation("files", 20, 1000),
        {
          ...observation("typepeek-skill", 10, 400),
          finalAnswer: { passed: false },
        },
      ],
      ["example"]
    );

    expect(matrix.overall).toMatchObject({
      pairs: 0,
      typepeek: { reportedTokens: 400, successful: 0, verifiedEvidence: 1 },
    });
  });
});
