import { describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";

import type { CodexOptions } from "../benchmarks/codex-discovery/options.ts";
import type { CodexAttempt } from "../benchmarks/codex-discovery/report.ts";
import { summarizeCodexStudy } from "../benchmarks/codex-discovery/report.ts";
import { selectCodexScenarios } from "../benchmarks/codex-discovery/scenarios.ts";
import { codexTelemetry } from "../benchmarks/codex-discovery/telemetry.ts";
import { match } from "./helpers/matchers.ts";

const options: CodexOptions = {
  cases: ["semver-clean"],
  conditions: ["files", "typepeek", "typepeek-skill"],
  deadlineSeconds: 120,
  dryRun: false,
  efforts: ["low"],
  models: ["gpt-5.6-luna"],
  output: "/unused",
  prepareOnly: false,
  repeats: 1,
  seed: 1729,
  startAt: 0,
  totalTokenLimit: 2_000_000,
  trialTokenLimit: 60_000,
};

const attempt = function attempt(
  condition: CodexAttempt["condition"],
  seconds: number,
  tokens: number
): CodexAttempt {
  return {
    acquisition: {
      acquisitionModelUsage: null,
      evidenceBytes: tokens * 4,
      evidenceEvents: [],
      evidenceTokens: tokens,
      firstRequestMilliseconds: 0,
      invalidReason: null,
      matchedFacts: ["answer"],
      measuredCommands: 0,
      missingExportIndexParts: 0,
      missingFacts: [],
      retrievalCalls: 1,
      retrievalSeconds: seconds,
      status: "complete",
      sufficientEvidenceMilliseconds: seconds * 1000,
      taskSubmittedMilliseconds: 0,
      taskToEvidenceSeconds: seconds,
      tokenization: {
        encoding: "o200k_base",
        package: "gpt-tokenizer",
        version: "4.0.0",
      },
      toolExecutionSeconds: null,
      toolRoundTripSeconds: seconds,
    },
    artifactDirectory: "/unused",
    classification: "task",
    condition,
    effort: "low",
    error: null,
    evidenceHash: "evidence",
    exitCode: 0,
    expectedFacts: ["answer"],
    model: "gpt-5.6-luna",
    passed: true,
    promptHash: "prompt",
    repeat: 0,
    seconds,
    task: "semver-clean",
    telemetry: codexTelemetry(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: tokens - 10, output_tokens: 10 },
      })
    ),
    timedOut: false,
  };
};

const report = function report(attempts: readonly CodexAttempt[]) {
  return summarizeCodexStudy({
    attempts,
    identity: {
      adapter: "package",
      architecture: "test",
      artifactHash: "artifact",
      codexHarnessHash: "codex",
      commit: "commit",
      compiler: "test",
      cpu: "test",
      evidenceHash: "evidence",
      harnessHash: "harness",
      hostname: "test",
      lockfileHash: "lock",
      node: "test",
      osRelease: "test",
      platform: "test",
      ripgrep: "test",
      skillHash: "skill",
      workspace: "/consumer",
    },
    options,
    scenarios: selectCodexScenarios(options.cases),
    status: "complete",
    version: "test",
  });
};

describe("codex-benchmark-report", () => {
  it("compares explicit skill use with CLI-only use on the same task and repetition", () => {
    const { data } = report([
      attempt("files", 40, 800),
      attempt("typepeek", 20, 400),
      attempt("typepeek-skill", 10, 200),
    ]);

    expect(
      data.groups.find(({ condition }) => condition === "typepeek-skill")
    ).toMatchObject({
      comparisons: match.arrayContaining([
        {
          baseline: "typepeek",
          pairs: 1,
          time: {
            medianRatio: 2,
            medianSaved: 10,
            ratioCi95: null,
            unit: "seconds",
          },
          tokens: {
            medianRatio: 2,
            medianSaved: 200,
            ratioCi95: null,
            unit: "tokens",
          },
        },
      ]),
    });
  });

  it("keeps unknown token breakdowns and partial usage out of cost comparisons", () => {
    const partial = { ...attempt("typepeek-skill", 10, 200) };

    delete partial.acquisition;

    const { data } = report([
      attempt("files", 40, 800),
      attempt("typepeek", 20, 400),
      {
        ...partial,
        telemetry: { ...partial.telemetry, usageComplete: false },
      },
    ]);

    const skill = requireDefined(
      data.groups.find(({ condition }) => condition === "typepeek-skill")
    );

    expect([
      skill,
      skill.comparisons.every(({ tokens }) => tokens === null),
    ]).toStrictEqual([
      match.objectContaining({
        reportedCachedInputTokens: null,
        reportedInputTokens: 190,
        reportedOutputTokens: 10,
        usageComplete: false,
        wholeRunTokensPerAcquisition: null,
      }),
      true,
    ]);
  });

  it("retains evidence tokens when legacy traces have no task-submission timing", () => {
    const legacy = attempt("typepeek-skill", 10, 200);

    const { data } = report([
      attempt("files", 40, 800),
      {
        ...legacy,
        acquisition: {
          ...requireDefined(legacy.acquisition),
          taskSubmittedMilliseconds: null,
          taskToEvidenceSeconds: null,
        },
      },
    ]);

    for (const groups of [data.groups, data.byTask]) {
      const skill = requireDefined(
        groups.find(({ condition }) => condition === "typepeek-skill")
      );

      expect([
        skill.successfulSeconds === null,
        skill.successfulEvidenceTokens,
        skill.successByDeadline,
        skill.comparisons[0],
      ]).toStrictEqual([
        true,
        match.objectContaining({
          count: 1,
          mean: 200,
        }),
        {
          120: null,
          30: null,
          60: null,
        },
        match.objectContaining({
          pairs: 1,
          time: null,
          tokens: match.objectContaining({ medianRatio: 4, medianSaved: 600 }),
        }),
      ]);
    }
  });
});
