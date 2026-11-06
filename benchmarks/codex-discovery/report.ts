import { Predicate } from "effect";

import { requireDefined } from "#typepeek/defined-value";

import type { DiscoveryIdentity } from "../support/identity.ts";
import {
  comparePairedObservations,
  summarizeObservations,
} from "../support/statistics.ts";
import type { measureAcquisition } from "./acquisition.ts";
import type { CodexOptions } from "./options.ts";
import type { CodexCondition, CodexScenario } from "./scenarios.ts";
import type { codexTelemetry } from "./telemetry.ts";

export interface CodexAttempt {
  readonly classification: "task" | "infrastructure";
  readonly task: string;
  readonly model: string;
  readonly effort: string;
  readonly condition: CodexCondition;
  readonly repeat: number;
  readonly seconds: number;
  readonly instructionTokens?: {
    readonly prompt: number;
    readonly skill: number;
    readonly scope: string;
  };
  readonly acquisition?: ReturnType<typeof measureAcquisition>;
  readonly finalAnswer?: {
    readonly passed: boolean;
    readonly error: string | null;
  };
  readonly wholeRunError?: string | null;
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

const compareAttempts = function compareAttempts(
  successes: readonly CodexAttempt[],
  attempts: readonly CodexAttempt[],
  baselineCondition: string,
  seed: number
) {
  const pairs = successes.flatMap((treatment) => {
    const baseline = attempts.find((candidate) => {
      if (candidate.condition !== baselineCondition) {
        return false;
      }

      if (candidate.model !== treatment.model) {
        return false;
      }

      if (candidate.effort !== treatment.effort) {
        return false;
      }

      if (candidate.task !== treatment.task) {
        return false;
      }

      if (candidate.repeat !== treatment.repeat) {
        return false;
      }

      if (candidate.classification !== "task") {
        return false;
      }

      return candidate.passed;
    });

    return baseline === undefined ? [] : [{ baseline, treatment }];
  });

  return {
    baseline: baselineCondition,
    pairs: pairs.length,
    time:
      pairs.length === 0 ||
      pairs.some(
        ({ baseline, treatment }) =>
          !Predicate.isNotNullish(
            baseline.acquisition?.taskToEvidenceSeconds
          ) ||
          !Predicate.isNotNullish(treatment.acquisition?.taskToEvidenceSeconds)
      )
        ? null
        : {
            unit: "seconds",
            ...comparePairedObservations(
              pairs.map(({ baseline }) =>
                requireDefined(
                  requireDefined(baseline.acquisition).taskToEvidenceSeconds
                )
              ),
              pairs.map(({ treatment }) =>
                requireDefined(
                  requireDefined(treatment.acquisition).taskToEvidenceSeconds
                )
              ),
              seed
            ),
          },
    tokens:
      pairs.length === 0 ||
      pairs.some(
        ({ baseline, treatment }) =>
          baseline.acquisition === undefined ||
          treatment.acquisition === undefined
      )
        ? null
        : {
            unit: "tokens",
            ...comparePairedObservations(
              pairs.map(
                ({ baseline }) =>
                  requireDefined(baseline.acquisition).evidenceTokens
              ),
              pairs.map(
                ({ treatment }) =>
                  requireDefined(treatment.acquisition).evidenceTokens
              ),
              seed
            ),
          },
  };
};

export const summarizeCodexStudy = function summarizeCodexStudy({
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
  const summarizeCondition = (
    task: string | undefined,
    model: CodexOptions["models"][number],
    effort: CodexOptions["efforts"][number],
    condition: CodexOptions["conditions"][number]
  ) => {
    const recorded = attempts.filter((attempt) => {
      if (attempt.model !== model) {
        return false;
      }

      if (attempt.effort !== effort) {
        return false;
      }

      if (attempt.condition !== condition) {
        return false;
      }

      return task === undefined || attempt.task === task;
    });

    const selected = recorded.filter(
      (attempt) => attempt.classification === "task"
    );

    const successes = selected.filter((attempt) => attempt.passed);

    const acquired = successes.filter((attempt) =>
      Predicate.isNotNullish(attempt.acquisition?.taskToEvidenceSeconds)
    );

    const evidence = successes.flatMap((attempt) =>
      attempt.acquisition === undefined ? [] : [attempt.acquisition]
    );

    const expectedAttempts =
      (task === undefined ? scenarios.length : 1) * options.repeats;

    const timing =
      acquired.length === 0
        ? null
        : summarizeObservations(
            acquired.map((attempt) =>
              requireDefined(
                requireDefined(attempt.acquisition).taskToEvidenceSeconds
              )
            )
          );

    const completeUsage =
      recorded.length > 0 &&
      recorded.every(
        (attempt) =>
          attempt.telemetry.usageComplete &&
          attempt.telemetry.inputTokens !== null &&
          attempt.telemetry.outputTokens !== null
      );

    const sum = (field: "inputTokens" | "outputTokens" | "cachedInputTokens") =>
      recorded.reduce(
        (total, attempt) => total + (attempt.telemetry[field] ?? 0),
        0
      );

    const input = sum("inputTokens");
    const output = sum("outputTokens");

    const readBaselines = (): readonly CodexCondition[] => {
      if (condition === "files") {
        return [];
      }

      if (condition === "typepeek") {
        return ["files"];
      }

      return ["files", "typepeek"];
    };

    const baselines = readBaselines();

    return {
      attempts: selected.length,
      cliAdoptionRate:
        selected.length === 0
          ? null
          : selected.filter((attempt) => attempt.telemetry.usedTypepeek)
              .length / selected.length,
      comparisons: baselines
        .filter((baseline) =>
          options.conditions.some((value) => value === baseline)
        )
        .map((baseline) =>
          compareAttempts(successes, attempts, baseline, options.seed)
        ),
      condition,
      coverageComplete: selected.length === expectedAttempts,
      effort,
      evidenceComplete: successes.length,
      expectedAttempts,
      infrastructureFailures: recorded.length - selected.length,
      intervalScope:
        "Descriptive run-level variability within these fixed tasks; not uncertainty across tasks or packages.",
      model,
      precisionWithinTenPercent: Predicate.isNotNullish(
        timing?.meanCi95HalfWidth
      )
        ? timing.meanCi95HalfWidth / timing.mean <= 0.1
        : null,
      reportedCachedInputTokens:
        recorded.length > 0 &&
        recorded.every(
          (attempt) => attempt.telemetry.cachedInputTokens !== null
        )
          ? sum("cachedInputTokens")
          : null,
      reportedInputTokens: input,
      reportedOutputTokens: output,
      reportedReasoningOutputTokens:
        recorded.every(
          (attempt) => attempt.telemetry.reasoningOutputTokens !== null
        ) && recorded.length > 0
          ? recorded.reduce(
              (total, attempt) =>
                total + (attempt.telemetry.reasoningOutputTokens ?? 0),
              0
            )
          : null,
      successByDeadline: Object.fromEntries(
        [30, 60, 120].map((deadline) => [
          deadline,
          selected.length === 0 || acquired.length !== successes.length
            ? null
            : acquired.filter(
                (attempt) =>
                  requireDefined(
                    requireDefined(attempt.acquisition).taskToEvidenceSeconds
                  ) <= deadline
              ).length / selected.length,
        ])
      ),
      successRate:
        selected.length === 0 ? null : successes.length / selected.length,
      successfulEvidenceTokens:
        evidence.length === 0
          ? null
          : summarizeObservations(
              evidence.map((acquisition) => acquisition.evidenceTokens)
            ),
      successfulSeconds: timing,
      usageComplete: completeUsage,
      wholeRun: {
        allAttemptSeconds:
          selected.length === 0
            ? null
            : summarizeObservations(selected.map((attempt) => attempt.seconds)),
        successfulSeconds:
          successes.length === 0
            ? null
            : summarizeObservations(
                successes.map((attempt) => attempt.seconds)
              ),
      },
      wholeRunTokensPerAcquisition:
        completeUsage && successes.length > 0
          ? (input + output) / successes.length
          : null,
    };
  };

  const groupsForModel = (
    task: string | undefined,
    model: CodexOptions["models"][number]
  ) =>
    options.efforts.flatMap((effort) =>
      options.conditions.map((condition) =>
        summarizeCondition(task, model, effort, condition)
      )
    );

  const makeGroups = (task?: string) =>
    options.models.flatMap((model) => groupsForModel(task, model));

  const groups = makeGroups();

  const byTask = scenarios.flatMap((scenario) =>
    makeGroups(scenario.workload.id).map((group) => ({
      ...group,
      specifier: scenario.workload.specifier,
      task: scenario.workload.id,
    }))
  );

  const data = {
    attempts,
    byTask,
    codexVersion: version,
    groups,
    identity,
    kind: "codex-discovery-benchmark",
    options,
    recordedAt: new Date().toISOString(),
    schemaVersion: 4,
    status,
  };

  const table = [
    "Task-to-evidence time: installed-dependency acquisition by tool-use condition",
    "Model | Effort | Tools | Evidence complete / attempts | Mean task-to-evidence seconds ± 95% CI | Mean evidence tokens",
    "--- | --- | --- | --- | --- | ---",
    ...groups.map((group) =>
      [
        group.model,
        group.effort,
        group.condition,
        `${group.evidenceComplete}/${group.attempts}`,
        group.successfulSeconds === null
          ? "n/a"
          : `${group.successfulSeconds.mean.toFixed(1)} ± ${group.successfulSeconds.meanCi95HalfWidth?.toFixed(1) ?? "n/a"}`,
        group.successfulEvidenceTokens?.mean.toFixed(0) ??
          "unknown/no successes",
      ].join(" | ")
    ),
    "",
    "Ratios = baseline / treatment; values above 1 favor treatment.",
    "Model / effort | Treatment vs baseline | Complete pairs | Median task-to-evidence time ratio | Median evidence token ratio",
    "--- | --- | --- | --- | ---",
    ...groups.flatMap((group) =>
      group.comparisons.map((comparison) =>
        [
          `${group.model}/${group.effort}`,
          `${group.condition}/${comparison.baseline}`,
          comparison.pairs,
          comparison.time?.medianRatio.toFixed(2) ?? "n/a",
          comparison.tokens?.medianRatio.toFixed(2) ?? "unknown",
        ].join(" | ")
      )
    ),
    "",
    "Evidence tokens use the pinned o200k_base reference tokenizer, not provider billing. Acquisition model usage is unknown. Whole-run usage is reported separately in summary.json and includes failures.",
    "Infrastructure failures are excluded from task-quality denominators; their known tokens remain in totals. See summary.json for their counts.",
    "Intervals describe run-level variability for these fixed tasks, not uncertainty across tasks or packages. Timing starts at task submission, includes initial strategy selection, and stops at sufficient tool-response evidence. Final-answer writing is excluded. Ratios use successful pairs only; compare success rates alongside them.",
    "Reasoning tokens, when reported, are a breakdown of output; they are not added twice. Subscription billing is not inferred from token counts.",
    "",
    "Task | Model / effort | Tools | Evidence complete / attempts | Mean task-to-evidence seconds | Mean evidence tokens",
    "--- | --- | --- | --- | --- | ---",
    ...byTask.map((group) =>
      [
        group.task,
        `${group.model}/${group.effort}`,
        group.condition,
        `${group.evidenceComplete}/${group.attempts}`,
        group.successfulSeconds?.mean.toFixed(1) ?? "n/a",
        group.successfulEvidenceTokens?.mean.toFixed(0) ??
          "unknown/no successes",
      ].join(" | ")
    ),
  ].join("\n");

  return { data, markdown: `${table}\n` };
};
