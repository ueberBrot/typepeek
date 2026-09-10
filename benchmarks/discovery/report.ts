import { Schema } from "effect";
import { createHash } from "node:crypto";

import { comparePairedTimings, medianValue, summarizeTimings } from "./statistics.ts";

const CONDITIONS = ["files", "compiler", "typepeek-cold", "typepeek-warm"] as const;
export type DiscoveryCondition = (typeof CONDITIONS)[number];
const nonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const positive = Schema.Finite.check(Schema.isGreaterThan(0));
const natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const sampleSchema = Schema.Struct({
  iteration: natural,
  milliseconds: positive,
  stdoutBytes: natural,
  passed: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  factsHash: Schema.NullOr(Schema.String),
  toolCalls: natural,
});
const identitySchema = Schema.Struct({
  workspace: Schema.String,
  node: Schema.String,
  compiler: Schema.String,
  ripgrep: Schema.String,
  platform: Schema.String,
  architecture: Schema.String,
  osRelease: Schema.String,
  cpu: Schema.String,
  hostname: Schema.String,
  adapter: Schema.Literal("package"),
  evidenceHash: Schema.String,
  lockfileHash: Schema.String,
  artifactHash: Schema.String,
  harnessHash: Schema.String,
  commit: Schema.String,
});
const optionsSchema = Schema.Struct({
  iterations: Schema.Int.check(Schema.isGreaterThan(0)),
  warmups: natural,
  seed: natural,
  timeoutMs: positive,
  tolerancePercent: nonNegative,
  toleranceMs: nonNegative,
  maxCvPercent: positive,
});
const rowSchema = Schema.Struct({
  workload: Schema.String,
  condition: Schema.Literals(CONDITIONS),
  question: Schema.String,
  expectedFacts: Schema.Array(Schema.String),
  samples: Schema.Array(sampleSchema).check(Schema.isMinLength(1)),
});
const discoveryRunSchema = Schema.Struct({
  kind: Schema.Literal("discovery-benchmark"),
  schemaVersion: Schema.Literal(2),
  workloads: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  recordedAt: Schema.String,
  identity: identitySchema,
  options: optionsSchema,
  evidenceUnchanged: Schema.Boolean,
  inputsUnchanged: Schema.Boolean,
  rows: Schema.Array(rowSchema).check(Schema.isMinLength(1)),
});
export type DiscoverySample = typeof sampleSchema.Type;
export type DiscoveryRow = typeof rowSchema.Type;
export type DiscoveryRun = typeof discoveryRunSchema.Type;
export type DiscoveryIdentity = typeof identitySchema.Type;
export type DiscoveryOptions = typeof optionsSchema.Type;
export const decodeDiscoveryRun = Schema.decodeUnknownSync(discoveryRunSchema);

function validSamples(row: DiscoveryRow, iterations: number): boolean {
  const expectedHash = createHash("sha256").update(JSON.stringify(row.expectedFacts)).digest("hex");
  return (
    row.samples.length === iterations &&
    row.samples.every(
      (sample, index) =>
        sample.passed &&
        sample.error === null &&
        sample.factsHash === expectedHash &&
        sample.iteration === index,
    )
  );
}

export function evaluateDiscoveryRun(run: DiscoveryRun, baseline?: DiscoveryRun) {
  const correctness = validRun(run);
  const mismatches = baseline === undefined ? [] : compatibilityMismatches(run, baseline);
  const rows = run.rows.map((row) => {
    const timings = summarizeTimings(row.samples.map((sample) => sample.milliseconds));
    const correctness = validSamples(row, run.options.iterations);
    const stable =
      timings.count >= 5 && timings.coefficientOfVariationPercent <= run.options.maxCvPercent;
    const previous = baseline?.rows.find(
      (candidate) => candidate.workload === row.workload && candidate.condition === row.condition,
    );
    const previousMedian =
      previous === undefined
        ? null
        : summarizeTimings(previous.samples.map((sample) => sample.milliseconds)).median;
    const tolerance =
      previousMedian === null
        ? null
        : Math.max(run.options.toleranceMs, (previousMedian * run.options.tolerancePercent) / 100);
    const regressed =
      previousMedian !== null && tolerance !== null && timings.median > previousMedian + tolerance;
    return {
      workload: row.workload,
      condition: row.condition,
      correctness,
      stable,
      timings,
      medianStdoutBytes: medianValue(row.samples.map((sample) => sample.stdoutBytes)),
      medianToolCalls: medianValue(row.samples.map((sample) => sample.toolCalls)),
      previousMedian,
      tolerance,
      regressed,
    };
  });
  const comparisons = run.rows
    .filter((row) => row.condition === "compiler" || row.condition === "files")
    .flatMap((row) =>
      ["typepeek-cold", "typepeek-warm"].map((condition) => {
        const treatment = run.rows.find(
          (candidate) => candidate.workload === row.workload && candidate.condition === condition,
        );
        const eligible =
          correctness &&
          treatment !== undefined &&
          validSamples(row, run.options.iterations) &&
          validSamples(treatment, run.options.iterations);
        return {
          workload: row.workload,
          baseline: row.condition,
          treatment: condition,
          comparison: eligible
            ? comparePairedTimings(
                row.samples.map((sample) => sample.milliseconds),
                treatment.samples.map((sample) => sample.milliseconds),
                run.options.seed,
              )
            : null,
        };
      }),
    );
  return {
    correctness,
    stable: rows.length > 0 && rows.every((row) => row.stable),
    baselineCompatible: mismatches.length === 0,
    incompatibilities: mismatches,
    passed:
      correctness && mismatches.length === 0 && rows.every((row) => row.stable && !row.regressed),
    rows,
    comparisons,
  };
}

function validRun(run: DiscoveryRun): boolean {
  const groups = Map.groupBy(run.rows, (row) => row.workload);
  return (
    run.evidenceUnchanged &&
    run.inputsUnchanged &&
    groups.size > 0 &&
    groups.size === run.workloads.length &&
    new Set(run.workloads).size === run.workloads.length &&
    run.workloads.every((workload) => groups.has(workload)) &&
    [...groups.values()].every((rows) => {
      const conditions = new Set(rows.map((row) => row.condition));
      return (
        conditions.size === rows.length &&
        ["compiler", "typepeek-cold", "typepeek-warm"].every((condition) =>
          rows.some((row) => row.condition === condition),
        ) &&
        rows.every(
          (row) =>
            validSamples(row, run.options.iterations) &&
            JSON.stringify(row.expectedFacts) === JSON.stringify(rows[0]!.expectedFacts),
        )
      );
    })
  );
}

function compatibilityMismatches(current: DiscoveryRun, baseline: DiscoveryRun): readonly string[] {
  const keys = [
    "node",
    "compiler",
    "ripgrep",
    "platform",
    "architecture",
    "osRelease",
    "cpu",
    "hostname",
    "adapter",
    "evidenceHash",
    "lockfileHash",
    "harnessHash",
  ] as const;
  const mismatches: string[] = keys.filter(
    (key) => current.identity[key] !== baseline.identity[key],
  );
  for (const key of ["warmups", "seed", "timeoutMs"] as const) {
    if (current.options[key] !== baseline.options[key]) mismatches.push(key);
  }
  const rowKey = (row: DiscoveryRow) => `${row.workload}/${row.condition}`;
  if (
    JSON.stringify(current.rows.map(rowKey).sort()) !==
    JSON.stringify(baseline.rows.map(rowKey).sort())
  ) {
    mismatches.push("workload/condition coverage");
  }
  if (!validRun(baseline) || baseline.rows.some((row) => row.samples.length < 5)) {
    mismatches.push("baseline correctness or sample count");
  }
  for (const row of baseline.rows) {
    const candidate = current.rows.find((currentRow) => rowKey(currentRow) === rowKey(row));
    if (
      candidate !== undefined &&
      JSON.stringify(candidate.expectedFacts) !== JSON.stringify(row.expectedFacts)
    ) {
      mismatches.push(`expected evidence: ${rowKey(row)}`);
    }
    if (
      summarizeTimings(row.samples.map((sample) => sample.milliseconds))
        .coefficientOfVariationPercent > current.options.maxCvPercent
    ) {
      mismatches.push(`unstable baseline: ${rowKey(row)}`);
    }
  }
  return mismatches;
}

export function renderDiscoveryReport(
  run: DiscoveryRun,
  evaluation: ReturnType<typeof evaluateDiscoveryRun>,
  gateRequested: boolean,
): string {
  const lines = [
    "Installed dependency discovery (milliseconds, fresh process per observation)",
    `${run.options.iterations} measured repetitions; ${run.options.warmups} warmups; seed ${run.options.seed}`,
    "Mean ± 95% Student t interval; CV measures sample variability. OS caches are not flushed.",
    "typepeek-cold bypasses persistent cache; typepeek-warm enables a primed cache (hits are not instrumented).",
    "",
    "Workload | Method | Correct | Mean ± 95% CI | Median | p95 | CV | Output bytes | Operations",
    "--- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...evaluation.rows.map((row) =>
      [
        row.workload,
        row.condition,
        row.correctness ? "yes" : "NO",
        `${row.timings.mean.toFixed(1)} ± ${row.timings.meanCi95HalfWidth?.toFixed(1) ?? "n/a"}`,
        row.timings.median.toFixed(1),
        row.timings.p95.toFixed(1),
        `${row.timings.coefficientOfVariationPercent.toFixed(1)}%`,
        String(row.medianStdoutBytes),
        String(row.medianToolCalls),
      ].join(" | "),
    ),
    "",
    "Paired speedup = baseline / Typepeek (>1 favors Typepeek; <1 favors baseline).",
    ...evaluation.comparisons.map(
      (row) =>
        `${row.workload}: ${row.baseline} / ${row.treatment}: ${row.comparison === null ? "not comparable: incorrect evidence" : `${row.comparison.medianSpeedup.toFixed(2)}x${row.comparison.speedupCi95 === null ? "" : ` [95% bootstrap ${row.comparison.speedupCi95[0].toFixed(2)}, ${row.comparison.speedupCi95[1].toFixed(2)}]`}`}`,
    ),
    "",
    `Correctness: ${evaluation.correctness ? "PASS" : "FAIL"}; timing stability: ${evaluation.stable ? "PASS" : "INSUFFICIENT/NOISY"}; regression gate: ${!gateRequested ? "NOT REQUESTED" : evaluation.passed ? "PASS" : "FAIL"}`,
    ...evaluation.incompatibilities.map((value) => `Incompatible baseline: ${value}`),
    ...evaluation.rows
      .filter((row) => row.regressed)
      .map(
        (row) =>
          `Regression: ${row.workload}/${row.condition}, median ${row.timings.median.toFixed(1)} ms exceeds ${row.previousMedian?.toFixed(1)} + ${row.tolerance?.toFixed(1)} ms`,
      ),
  ];
  return `${lines.join("\n")}\n`;
}
