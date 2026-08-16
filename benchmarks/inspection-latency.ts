import { execa } from "execa";
// fallow-ignore-file unused-file -- executable benchmark invoked by Vite+ tasks
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

interface BenchmarkCase {
  readonly name: string;
  readonly arguments_: readonly string[];
}

interface ProfilePhase {
  readonly name: string;
  readonly milliseconds: number;
}

interface DurationSummary {
  readonly min: number;
  readonly mean: number;
  readonly max: number;
}

interface BenchmarkReport {
  readonly kind: "inspection-latency-benchmark";
  readonly schemaVersion: 1;
  readonly adapter: "build" | "package" | "source";
  readonly iterations: number;
  readonly cases: readonly {
    readonly name: string;
    readonly statuses: readonly string[];
    readonly wallMilliseconds: DurationSummary;
    readonly phases: readonly {
      readonly name: string;
      readonly milliseconds: DurationSummary;
    }[];
  }[];
}

const benchmarkCases: readonly BenchmarkCase[] = [
  { name: "interface-overview", arguments_: ["overview", "arktype", "--json"] },
  {
    name: "signature-inspection",
    arguments_: ["signatures", "arktype", "type", "--json"],
  },
  { name: "export-search", arguments_: ["search", "arktype", "type", "--json"] },
  { name: "public-subpath-discovery", arguments_: ["subpaths", "arktype", "--json"] },
];

const options = readOptions(process.argv.slice(2));
const executable = adapterEntrypoint(options.adapter);
const cases = [];

for (const benchmarkCase of benchmarkCases) {
  const durations: number[] = [];
  const statuses: string[] = [];
  const phaseDurations = new Map<string, number[]>();
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const startedAt = performance.now();
    const result = await execa(
      process.execPath,
      [executable, ...benchmarkCase.arguments_, "--context", resolve(".")],
      {
        ...(options.adapter === "source" ? { env: { TYPEPEEK_PROFILE: "1" } } : {}),
        reject: false,
      },
    );
    durations.push(roundedMilliseconds(performance.now() - startedAt));
    const outcome = JSON.parse(result.stdout) as { readonly status?: unknown };
    statuses.push(typeof outcome.status === "string" ? outcome.status : "invalid");
    for (const phase of readProfile(result.stderr, options.adapter).phases) {
      const values = phaseDurations.get(phase.name) ?? [];
      values.push(phase.milliseconds);
      phaseDurations.set(phase.name, values);
    }
  }
  cases.push({
    name: benchmarkCase.name,
    statuses,
    wallMilliseconds: summarize(durations),
    phases: [...phaseDurations].map(([name, durations_]) => ({
      name,
      milliseconds: summarize(durations_),
    })),
  });
}

const report: BenchmarkReport = {
  kind: "inspection-latency-benchmark",
  schemaVersion: 1,
  adapter: options.adapter,
  iterations: options.iterations,
  cases,
};
process.stdout.write(
  options.json ? `${JSON.stringify(report)}\n` : `${renderHumanReport(report)}\n`,
);

function readOptions(arguments_: readonly string[]): {
  readonly adapter: "build" | "package" | "source";
  readonly iterations: number;
  readonly json: boolean;
} {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      adapter: { type: "string", default: "source" },
      iterations: { type: "string", default: "5" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  return {
    adapter: readAdapter(values.adapter),
    iterations: readIterations(values.iterations),
    json: values.json,
  };
}

function readAdapter(value: string | undefined): "build" | "package" | "source" {
  if (value !== "source" && value !== "build" && value !== "package") {
    throw new TypeError("--adapter must be source, build, or package.");
  }
  return value;
}

function readIterations(value: string | undefined): number {
  const iterations = Number(value);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
    throw new TypeError("--iterations must be an integer from 1 through 100.");
  }
  return iterations;
}

function adapterEntrypoint(adapter: "build" | "package" | "source"): string {
  switch (adapter) {
    case "source":
      return "src/cli.ts";
    case "build":
      return ".vite-plus/build/cli.js";
    case "package":
      return "dist/cli.js";
  }
}

function readProfile(
  serialized: string,
  adapter: "build" | "package" | "source",
): { readonly phases: readonly ProfilePhase[] } {
  if (adapter !== "source" && serialized === "") {
    return { phases: [] };
  }
  const profile: unknown = JSON.parse(serialized);
  if (!isPerformanceProfile(profile)) {
    throw new TypeError("Inspection did not emit a valid performance profile.");
  }
  return profile;
}

function isPerformanceProfile(
  value: unknown,
): value is { readonly phases: readonly ProfilePhase[] } {
  if (typeof value !== "object") {
    return false;
  }
  if (value === null) {
    return false;
  }
  const candidate = value as { readonly kind?: unknown; readonly phases?: unknown };
  if (candidate.kind !== "inspection-profile") {
    return false;
  }
  return Array.isArray(candidate.phases);
}

function summarize(values: readonly number[]): DurationSummary {
  return {
    min: Math.min(...values),
    mean: roundedMilliseconds(values.reduce((sum, value) => sum + value, 0) / values.length),
    max: Math.max(...values),
  };
}

function roundedMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds * 1_000) / 1_000;
}

function renderHumanReport(report: BenchmarkReport): string {
  return [
    `Inspection latency benchmark (${report.adapter}; ${report.iterations} iterations)`,
    ...report.cases.flatMap((benchmarkCase) => [
      `${benchmarkCase.name}: ${benchmarkCase.wallMilliseconds.mean} ms mean (${benchmarkCase.wallMilliseconds.min}-${benchmarkCase.wallMilliseconds.max} ms)`,
      ...benchmarkCase.phases.map((phase) => `  ${phase.name}: ${phase.milliseconds.mean} ms mean`),
    ]),
  ].join("\n");
}
