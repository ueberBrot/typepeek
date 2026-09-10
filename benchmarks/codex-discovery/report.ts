import type { DiscoveryIdentity } from "../discovery/report.ts";
import { comparePairedTimings, summarizeTimings } from "../discovery/statistics.ts";
import type { CodexOptions } from "./options.ts";
import type { CodexCondition, CodexScenario, codexTelemetry } from "./scenarios.ts";

export interface CodexAttempt {
  readonly classification: "task" | "infrastructure";
  readonly task: string;
  readonly model: string;
  readonly effort: string;
  readonly condition: CodexCondition;
  readonly repeat: number;
  readonly seconds: number;
  readonly passed: boolean;
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly promptHash: string;
  readonly evidenceHash: string;
  readonly expectedFacts: readonly string[];
  readonly telemetry: ReturnType<typeof codexTelemetry>;
  readonly artifactDirectory: string;
}

export function summarizeCodexStudy({
  status,
  options,
  scenarios,
  attempts,
  version,
  identity,
}: {
  readonly status: string;
  readonly options: CodexOptions;
  readonly scenarios: readonly CodexScenario[];
  readonly attempts: readonly CodexAttempt[];
  readonly version: string;
  readonly identity: DiscoveryIdentity & {
    readonly codexHarnessHash: string;
    readonly skillHash: string;
  };
}) {
  const makeGroups = (task?: string) =>
    options.models.flatMap((model) =>
      options.efforts.flatMap((effort) =>
        options.conditions.map((condition) => {
          const recorded = attempts.filter(
            (attempt) =>
              attempt.model === model &&
              attempt.effort === effort &&
              attempt.condition === condition &&
              (task === undefined || attempt.task === task),
          );
          const selected = recorded.filter((attempt) => attempt.classification === "task");
          const successes = selected.filter((attempt) => attempt.passed);
          const completeUsage =
            recorded.length > 0 &&
            recorded.every(
              (attempt) =>
                attempt.telemetry.usageComplete &&
                attempt.telemetry.inputTokens !== null &&
                attempt.telemetry.outputTokens !== null,
            );
          const sum = (field: "inputTokens" | "outputTokens" | "cachedInputTokens") =>
            recorded.reduce((total, attempt) => total + (attempt.telemetry[field] ?? 0), 0);
          const input = sum("inputTokens");
          const output = sum("outputTokens");
          const baselines =
            condition === "files"
              ? []
              : condition === "typepeek"
                ? ["files"]
                : ["files", "typepeek"];
          return {
            model,
            effort,
            condition,
            infrastructureFailures: recorded.length - selected.length,
            intervalScope:
              "Descriptive run-level variability within these fixed tasks; not uncertainty across tasks or packages.",
            attempts: selected.length,
            correct: successes.length,
            successRate: selected.length === 0 ? null : successes.length / selected.length,
            successByDeadline: Object.fromEntries(
              [30, 60, 120].map((deadline) => [
                deadline,
                selected.length === 0
                  ? null
                  : successes.filter((attempt) => attempt.seconds <= deadline).length /
                    selected.length,
              ]),
            ),
            successfulSeconds:
              successes.length === 0
                ? null
                : summarizeTimings(successes.map((attempt) => attempt.seconds)),
            allAttemptSeconds:
              selected.length === 0
                ? null
                : summarizeTimings(selected.map((attempt) => attempt.seconds)),
            reportedInputTokens: input,
            reportedCachedInputTokens:
              recorded.length > 0 &&
              recorded.every((attempt) => attempt.telemetry.cachedInputTokens !== null)
                ? sum("cachedInputTokens")
                : null,
            reportedOutputTokens: output,
            reportedReasoningOutputTokens:
              recorded.every((attempt) => attempt.telemetry.reasoningOutputTokens !== null) &&
              recorded.length > 0
                ? recorded.reduce(
                    (total, attempt) => total + (attempt.telemetry.reasoningOutputTokens ?? 0),
                    0,
                  )
                : null,
            usageComplete: completeUsage,
            tokensPerCorrectAnswer:
              completeUsage && successes.length > 0 ? (input + output) / successes.length : null,
            cliAdoptionRate:
              selected.length === 0
                ? null
                : selected.filter((attempt) => attempt.telemetry.usedTypepeek).length /
                  selected.length,
            comparisons: baselines
              .filter((baseline) => options.conditions.some((value) => value === baseline))
              .map((baseline) => compareAttempts(successes, attempts, baseline, options.seed)),
          };
        }),
      ),
    );
  const groups = makeGroups();
  const byTask = scenarios.flatMap((scenario) =>
    makeGroups(scenario.workload.id).map((group) => ({
      ...group,
      task: scenario.workload.id,
      specifier: scenario.workload.specifier,
    })),
  );
  const data = {
    kind: "codex-discovery-benchmark",
    schemaVersion: 2,
    status,
    codexVersion: version,
    identity,
    recordedAt: new Date().toISOString(),
    options,
    groups,
    byTask,
    attempts,
  };
  const table = [
    "Codex installed-dependency discovery: verified final answers by tool-use condition",
    "Model | Effort | Tools | Correct / attempts | Successful mean seconds ± 95% CI | Reported input | Cached input | Output | Tokens per correct answer",
    "--- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...groups.map((group) =>
      [
        group.model,
        group.effort,
        group.condition,
        `${group.correct}/${group.attempts}`,
        group.successfulSeconds === null
          ? "n/a"
          : `${group.successfulSeconds.mean.toFixed(1)} ± ${group.successfulSeconds.meanCi95HalfWidth?.toFixed(1) ?? "n/a"}`,
        group.reportedInputTokens,
        group.reportedCachedInputTokens ?? "unknown",
        group.reportedOutputTokens,
        group.tokensPerCorrectAnswer?.toFixed(0) ?? "unknown/no successes",
      ].join(" | "),
    ),
    "",
    "Ratios = baseline / treatment; values above 1 favor treatment.",
    "Model / effort | Treatment vs baseline | Correct pairs | Median time ratio | Median token ratio",
    "--- | --- | --- | --- | ---",
    ...groups.flatMap((group) =>
      group.comparisons.map((comparison) =>
        [
          `${group.model}/${group.effort}`,
          `${group.condition}/${comparison.baseline}`,
          comparison.pairs,
          comparison.time?.medianRatio.toFixed(2) ?? "n/a",
          comparison.tokens?.medianRatio.toFixed(2) ?? "unknown",
        ].join(" | "),
      ),
    ),
    "",
    "Token totals include every recorded attempt, including failures. Unknown usage is not counted as zero-cost success.",
    "Infrastructure failures are excluded from task-quality denominators; their known tokens remain in totals. See summary.json for their counts.",
    "Intervals describe run-level variability for these fixed tasks, not uncertainty across tasks or packages. A recorded command is required, but evidence use needs trace review.",
    "Reasoning tokens, when reported, are a breakdown of output; they are not added twice. Subscription billing is not inferred from token counts.",
    "",
    "Task | Model / effort | Tools | Correct / attempts | Mean successful seconds | Tokens per correct answer",
    "--- | --- | --- | --- | --- | ---",
    ...byTask.map((group) =>
      [
        group.task,
        `${group.model}/${group.effort}`,
        group.condition,
        `${group.correct}/${group.attempts}`,
        group.successfulSeconds?.mean.toFixed(1) ?? "n/a",
        group.tokensPerCorrectAnswer?.toFixed(0) ?? "unknown/no successes",
      ].join(" | "),
    ),
  ].join("\n");
  return { data, markdown: `${table}\n` };
}

function compareMeasurements(
  baseline: readonly number[],
  treatment: readonly number[],
  seed: number,
  unit: "seconds" | "tokens",
) {
  const comparison = comparePairedTimings(baseline, treatment, seed);
  return {
    unit,
    medianRatio: comparison.medianSpeedup,
    ratioCi95: comparison.speedupCi95,
    medianSaved: comparison.medianSavedMilliseconds,
  };
}

function compareAttempts(
  successes: readonly CodexAttempt[],
  attempts: readonly CodexAttempt[],
  baselineCondition: string,
  seed: number,
) {
  const pairs = successes.flatMap((treatment) => {
    const baseline = attempts.find(
      (candidate) =>
        candidate.condition === baselineCondition &&
        candidate.model === treatment.model &&
        candidate.effort === treatment.effort &&
        candidate.task === treatment.task &&
        candidate.repeat === treatment.repeat &&
        candidate.classification === "task" &&
        candidate.passed,
    );
    return baseline === undefined ? [] : [{ baseline, treatment }];
  });
  return {
    baseline: baselineCondition,
    pairs: pairs.length,
    time:
      pairs.length === 0
        ? null
        : compareMeasurements(
            pairs.map(({ baseline }) => baseline.seconds),
            pairs.map(({ treatment }) => treatment.seconds),
            seed,
            "seconds",
          ),
    tokens:
      pairs.length === 0 ||
      pairs.some(
        ({ baseline, treatment }) =>
          !baseline.telemetry.usageComplete ||
          !treatment.telemetry.usageComplete ||
          baseline.telemetry.inputTokens === null ||
          baseline.telemetry.outputTokens === null ||
          treatment.telemetry.inputTokens === null ||
          treatment.telemetry.outputTokens === null,
      )
        ? null
        : compareMeasurements(
            pairs.map(
              ({ baseline }) => baseline.telemetry.inputTokens! + baseline.telemetry.outputTokens!,
            ),
            pairs.map(
              ({ treatment }) =>
                treatment.telemetry.inputTokens! + treatment.telemetry.outputTokens!,
            ),
            seed,
            "tokens",
          ),
  };
}
