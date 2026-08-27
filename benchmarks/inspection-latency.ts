import { execa } from "execa";
// fallow-ignore-file unused-file -- executable benchmark invoked by Vite+ tasks
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import {
  decodeInspectionProfile,
  type InspectionProfile,
} from "#typepeek/inspection/performance-profile";

import { readLatencyWorkloadName, selectLatencyWorkloads } from "./latency-workloads.ts";
import {
  encodeInspectionLatencyReport,
  type InspectionLatencyReport,
} from "./regression-policy.ts";

type DurationSummary = InspectionLatencyReport["cases"][number]["wallMilliseconds"];
type LatencyCaseReport = InspectionLatencyReport["cases"][number];

const options = readOptions(process.argv.slice(2));
const executable = adapterEntrypoint(options.adapter);
const cases: LatencyCaseReport[] = [];

for (const benchmarkCase of selectLatencyWorkloads(options.caseName)) {
  const analysisMaxRssBytes: number[] = [];
  const durations: number[] = [];
  const statuses: string[] = [];
  const phaseDurations = new Map<string, number[]>();
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const startedAt = performance.now();
    const result = await execa(
      process.execPath,
      [executable, ...benchmarkCase.arguments_, "--context", resolve(".")],
      {
        env: {
          TYPEPEEK_CACHE_BYPASS: "1",
          ...(options.adapter === "source" ? { TYPEPEEK_PROFILE: "1" } : {}),
        },
        reject: false,
      },
    );
    durations.push(roundedMilliseconds(performance.now() - startedAt));
    const outcome = JSON.parse(result.stdout) as { readonly status?: unknown };
    statuses.push(typeof outcome.status === "string" ? outcome.status : "invalid");
    const profile = readProfile(result.stderr, options.adapter);
    if (profile.maxRssBytes !== undefined) {
      analysisMaxRssBytes.push(profile.maxRssBytes);
    }
    for (const phase of profile.phases) {
      const values = phaseDurations.get(phase.name) ?? [];
      values.push(phase.milliseconds);
      phaseDurations.set(phase.name, values);
    }
  }
  cases.push({
    name: benchmarkCase.name,
    statuses,
    ...(analysisMaxRssBytes.length > 0
      ? { analysisMaxRssBytes: summarize(analysisMaxRssBytes) }
      : {}),
    wallMilliseconds: summarize(durations),
    phases: [...phaseDurations].map(([name, durations_]) => ({
      name,
      milliseconds: summarize(durations_),
    })),
  });
}

const report: InspectionLatencyReport = {
  kind: "inspection-latency-benchmark",
  schemaVersion: 1,
  adapter: options.adapter,
  iterations: options.iterations,
  cases,
};
process.stdout.write(
  options.json
    ? `${JSON.stringify(encodeInspectionLatencyReport(report))}\n`
    : `${renderHumanReport(report)}\n`,
);

function readOptions(arguments_: readonly string[]): {
  readonly adapter: "build" | "package" | "source";
  readonly caseName: ReturnType<typeof readLatencyWorkloadName> | undefined;
  readonly iterations: number;
  readonly json: boolean;
} {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      adapter: { type: "string", default: "source" },
      case: { type: "string" },
      iterations: { type: "string", default: "5" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  return {
    adapter: readAdapter(values.adapter),
    caseName: values.case === undefined ? undefined : readLatencyWorkloadName(values.case),
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
): {
  readonly maxRssBytes: number | undefined;
  readonly phases: InspectionProfile["phases"];
} {
  if (adapter !== "source" && serialized === "") {
    return { maxRssBytes: undefined, phases: [] };
  }
  const profile = decodeInspectionProfile(serialized);
  if (profile === undefined) {
    throw new TypeError("Inspection did not emit a valid performance profile.");
  }
  return { maxRssBytes: profile.maxRssBytes, phases: profile.phases };
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

function renderHumanReport(report: InspectionLatencyReport): string {
  return [
    `Inspection latency benchmark (${report.adapter}; ${report.iterations} iterations)`,
    ...report.cases.flatMap((benchmarkCase) => [
      `${benchmarkCase.name}: ${benchmarkCase.wallMilliseconds.mean} ms mean (${benchmarkCase.wallMilliseconds.min}-${benchmarkCase.wallMilliseconds.max} ms)`,
      ...benchmarkCase.phases.map((phase) => `  ${phase.name}: ${phase.milliseconds.mean} ms mean`),
    ]),
  ].join("\n");
}
