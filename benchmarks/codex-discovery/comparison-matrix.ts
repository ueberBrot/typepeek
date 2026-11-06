import { Schema } from "effect";

import { codexConditionSchema } from "./scenarios.ts";
import { taskTimingSchema } from "./task-timing.ts";

const tokenCount = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
);

export const comparisonObservationSchema = Schema.Struct({
  acquisition: Schema.optionalKey(
    Schema.Struct({ taskToEvidenceSeconds: Schema.NullOr(Schema.Finite) })
  ),
  artifactDirectory: Schema.String,
  classification: Schema.Literals(["task", "infrastructure"]),
  condition: codexConditionSchema,
  effort: Schema.String,
  finalAnswer: Schema.optionalKey(Schema.Struct({ passed: Schema.Boolean })),
  model: Schema.String,
  passed: Schema.Boolean,
  repeat: Schema.Int,
  task: Schema.String,
  telemetry: Schema.Struct({
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    usageComplete: Schema.Boolean,
  }),
  timing: Schema.optionalKey(taskTimingSchema),
});

export type ComparisonObservation = typeof comparisonObservationSchema.Type;

const successful = (attempt: ComparisonObservation) =>
  attempt.classification === "task" &&
  attempt.passed &&
  attempt.finalAnswer?.passed === true;

const tokens = (attempt: ComparisonObservation): number | null => {
  const { inputTokens, outputTokens, usageComplete } = attempt.telemetry;

  return usageComplete && inputTokens !== null && outputTokens !== null
    ? inputTokens + outputTokens
    : null;
};

const pairKey = (attempt: ComparisonObservation) =>
  JSON.stringify([attempt.model, attempt.effort, attempt.task, attempt.repeat]);

type Pair = readonly [ComparisonObservation, ComparisonObservation];

const compareMetric = (
  pairs: readonly Pair[],
  read: (attempt: ComparisonObservation) => number | null
) => {
  const known = pairs.flatMap(([files, typepeek]) => {
    const baseline = read(files);
    const treatment = read(typepeek);

    return baseline === null || treatment === null
      ? []
      : [{ baseline, treatment }];
  });

  if (known.length === 0 || known.length !== pairs.length) {
    return {
      files: null,
      knownPairs: known.length,
      savedPercent: null,
      typepeek: null,
    };
  }

  const files =
    known.reduce((sum, pair) => sum + pair.baseline, 0) / known.length;

  const typepeek =
    known.reduce((sum, pair) => sum + pair.treatment, 0) / known.length;

  return {
    files,
    knownPairs: known.length,
    savedPercent: files > 0 ? 100 * (1 - typepeek / files) : null,
    typepeek,
  };
};

const conditionTotals = (attempts: readonly ComparisonObservation[]) => {
  const counts = attempts.map(tokens);

  return {
    attempts: attempts.length,
    correctAnswers: attempts.filter((a) => a.finalAnswer?.passed === true)
      .length,
    infrastructureFailures: attempts.filter(
      (a) => a.classification === "infrastructure"
    ).length,
    reportedTokens: counts.every((value) => value !== null)
      ? counts.reduce((sum, value) => sum + value, 0)
      : null,
    successful: attempts.filter(successful).length,
    usageComplete: counts.every((value) => value !== null),
    verifiedEvidence: attempts.filter((a) => a.passed).length,
  };
};

const summarizeRow = (attempts: readonly ComparisonObservation[]) => {
  const files = attempts.filter((a) => a.condition === "files");
  const typepeek = attempts.filter((a) => a.condition === "typepeek-skill");
  const baseline = new Map(files.map((a) => [pairKey(a), a]));

  const pairs: Pair[] = typepeek.flatMap((treatment) => {
    const control = baseline.get(pairKey(treatment));

    return control !== undefined && successful(control) && successful(treatment)
      ? [[control, treatment] as const]
      : [];
  });

  return {
    evidenceTime: compareMetric(
      pairs,
      (a) => a.acquisition?.taskToEvidenceSeconds ?? null
    ),
    files: conditionTotals(files),
    outsideTools: compareMetric(
      pairs,
      (a) => a.timing?.outsideToolsSeconds ?? null
    ),
    pairs: pairs.length,
    taskTime: compareMetric(pairs, (a) => a.timing?.taskSeconds ?? null),
    tokens: compareMetric(pairs, tokens),
    toolTime: compareMetric(pairs, (a) => a.timing?.toolSeconds ?? null),
    typepeek: conditionTotals(typepeek),
  };
};

/** Compares both conditions on the same successful tasks, retaining all usage. */
export const summarizeComparisonMatrix = function summarizeComparisonMatrix(
  attempts: readonly ComparisonObservation[],
  cases: readonly string[]
) {
  const seen = new Set<string>();

  for (const attempt of attempts) {
    const key = `${pairKey(attempt)}/${attempt.condition}`;

    if (seen.has(key)) {
      throw new Error("Comparison matrix contains a duplicate trial.");
    }

    seen.add(key);
  }

  return {
    aggregation: "Arithmetic means over identical successful pairs.",
    byModelEffort: [...new Set(attempts.map((a) => a.model))].flatMap((model) =>
      [
        ...new Set(
          attempts.flatMap((a) => (a.model === model ? [a.effort] : []))
        ),
      ].map((effort) => ({
        ...summarizeRow(
          attempts.filter((a) => a.model === model && a.effort === effort)
        ),
        effort,
        model,
      }))
    ),
    byTask: cases.map((task) => ({
      ...summarizeRow(attempts.filter((a) => a.task === task)),
      task,
    })),
    measurement: "task-completion-v1",
    overall: summarizeRow(attempts),
  };
};

const seconds = (value: number | null) =>
  value === null ? "unknown" : `${value.toFixed(1)} s`;

const tokenText = (value: number | null) =>
  value === null ? "unknown" : `${(value / 1000).toFixed(1)}k`;

const saving = (value: number | null) =>
  value === null ? "unknown" : `${value.toFixed(1)}%`;

export const renderComparisonMatrix = (
  matrix: ReturnType<typeof summarizeComparisonMatrix>
): string =>
  [
    "Task | Time: files → Typepeek | Time saved | Tokens: files → Typepeek | Tokens saved | Pairs",
    "--- | ---: | ---: | ---: | ---: | ---:",
    ...[...matrix.byTask, { ...matrix.overall, task: "All tasks" }].map((row) =>
      [
        row.task,
        `${seconds(row.taskTime.files)} → ${seconds(row.taskTime.typepeek)}`,
        saving(row.taskTime.savedPercent),
        `${tokenText(row.tokens.files)} → ${tokenText(row.tokens.typepeek)}`,
        saving(row.tokens.savedPercent),
        row.pairs,
      ].join(" | ")
    ),
  ].join("\n");
