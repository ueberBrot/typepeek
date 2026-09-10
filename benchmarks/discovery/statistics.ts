export interface TimingSummary {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  readonly standardDeviation: number;
  readonly coefficientOfVariationPercent: number;
  readonly meanCi95HalfWidth: number | null;
}

export function summarizeTimings(samples: readonly number[]): TimingSummary {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new TypeError("Timings must contain finite positive observations.");
  }
  const sorted = samples.toSorted((left, right) => left - right);
  const count = samples.length;
  const mean = samples.reduce((sum, value) => sum + value, 0) / count;
  const variance =
    count < 2 ? 0 : samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  const standardDeviation = Math.sqrt(variance);
  return {
    count,
    min: sorted[0]!,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[count - 1]!,
    mean,
    standardDeviation,
    coefficientOfVariationPercent: (100 * standardDeviation) / mean,
    meanCi95HalfWidth:
      count < 2 ? null : (criticalValue(count - 1) * standardDeviation) / Math.sqrt(count),
  };
}

function quantile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
}

export function medianValue(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("A median requires finite observations.");
  }
  return quantile(
    values.toSorted((left, right) => left - right),
    0.5,
  );
}

function criticalValue(degreesOfFreedom: number): number {
  const values = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
    2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052,
    2.048, 2.045, 2.042,
  ];
  return (
    values[degreesOfFreedom - 1] ??
    (degreesOfFreedom < 60 ? 2.042 : degreesOfFreedom < 120 ? 2 : 1.98)
  );
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function shuffled<Value>(values: readonly Value[], random: () => number): Value[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export interface PairedComparison {
  readonly medianSpeedup: number;
  readonly speedupCi95: readonly [number, number] | null;
  readonly medianSavedMilliseconds: number;
}

export function comparePairedTimings(
  baseline: readonly number[],
  treatment: readonly number[],
  seed: number,
): PairedComparison {
  if (baseline.length !== treatment.length) {
    throw new TypeError("Paired timings require equal observation counts.");
  }
  summarizeTimings(baseline);
  summarizeTimings(treatment);
  const ratios = baseline.map((value, index) => value / treatment[index]!);
  const deltas = baseline.map((value, index) => value - treatment[index]!);
  const median = (values: readonly number[]) =>
    quantile(
      values.toSorted((a, b) => a - b),
      0.5,
    );
  const random = seededRandom(seed);
  const bootstraps =
    baseline.length < 5
      ? null
      : Array.from({ length: 2_000 }, () =>
          median(ratios.map(() => ratios[Math.floor(random() * ratios.length)]!)),
        ).sort((a, b) => a - b);
  return {
    medianSpeedup: median(ratios),
    speedupCi95:
      bootstraps === null ? null : [quantile(bootstraps, 0.025), quantile(bootstraps, 0.975)],
    medianSavedMilliseconds: median(deltas),
  };
}
