import { expect, it } from "vite-plus/test";

import type { CodexOptions } from "../benchmarks/codex-discovery/options.ts";
import { type CodexAttempt, summarizeCodexStudy } from "../benchmarks/codex-discovery/report.ts";
import { codexTelemetry, selectCodexScenarios } from "../benchmarks/codex-discovery/scenarios.ts";

const options: CodexOptions = {
  cases: ["execa-command"],
  models: ["gpt-5.6-luna"],
  efforts: ["low"],
  conditions: ["files", "typepeek", "typepeek-skill"],
  repeats: 1,
  deadlineSeconds: 120,
  trialTokenLimit: 60000,
  totalTokenLimit: 2000000,
  seed: 1729,
  output: "/unused",
  prepareOnly: false,
  dryRun: false,
};

function attempt(
  condition: CodexAttempt["condition"],
  seconds: number,
  tokens: number,
): CodexAttempt {
  return {
    classification: "task",
    task: "execa-command",
    model: "gpt-5.6-luna",
    effort: "low",
    condition,
    repeat: 0,
    seconds,
    passed: true,
    error: null,
    exitCode: 0,
    timedOut: false,
    promptHash: "prompt",
    evidenceHash: "evidence",
    expectedFacts: ["answer"],
    artifactDirectory: "/unused",
    telemetry: codexTelemetry(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: tokens - 10, output_tokens: 10 },
      }),
    ),
  };
}

function report(attempts: readonly CodexAttempt[]) {
  return summarizeCodexStudy({
    status: "complete",
    options,
    scenarios: selectCodexScenarios(options.cases),
    attempts,
    version: "test",
    identity: {
      workspace: "/consumer",
      node: "test",
      compiler: "test",
      ripgrep: "test",
      platform: "test",
      architecture: "test",
      osRelease: "test",
      cpu: "test",
      hostname: "test",
      adapter: "package",
      evidenceHash: "evidence",
      lockfileHash: "lock",
      artifactHash: "artifact",
      harnessHash: "harness",
      commit: "commit",
      codexHarnessHash: "codex",
      skillHash: "skill",
    },
  });
}

it("compares explicit skill use with CLI-only use on the same task and repetition", () => {
  const { data } = report([
    attempt("files", 40, 800),
    attempt("typepeek", 20, 400),
    attempt("typepeek-skill", 10, 200),
  ]);
  expect(data.groups.find(({ condition }) => condition === "typepeek-skill")).toMatchObject({
    comparisons: expect.arrayContaining([
      {
        baseline: "typepeek",
        pairs: 1,
        time: { unit: "seconds", medianRatio: 2, ratioCi95: null, medianSaved: 10 },
        tokens: { unit: "tokens", medianRatio: 2, ratioCi95: null, medianSaved: 200 },
      },
    ]),
  });
});

it("keeps unknown token breakdowns and partial usage out of cost comparisons", () => {
  const partial = attempt("typepeek-skill", 10, 200);
  const { data } = report([
    attempt("files", 40, 800),
    attempt("typepeek", 20, 400),
    { ...partial, telemetry: { ...partial.telemetry, usageComplete: false } },
  ]);
  const skill = data.groups.find(({ condition }) => condition === "typepeek-skill")!;
  expect(skill).toMatchObject({
    reportedInputTokens: 190,
    reportedOutputTokens: 10,
    reportedCachedInputTokens: null,
    usageComplete: false,
    tokensPerCorrectAnswer: null,
  });
  expect(skill.comparisons.every(({ tokens }) => tokens === null)).toBe(true);
});
