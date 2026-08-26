import { execa } from "execa";
import { expect, it } from "vite-plus/test";

import {
  BENCHMARK_LIMITS,
  type BenchmarkGateCheck,
  type BenchmarkLatencyCase,
  type BenchmarkLatencyCaseName,
  type BenchmarkMeasurements,
  type BenchmarkWorkloadMeasurement,
  type BenchmarkWorkloadId,
  evaluateBenchmarkGates,
  REQUIRED_AGENT_WORKLOADS,
  REQUIRED_LATENCY_CASES,
} from "../benchmarks/regression-policy.ts";

it("benchmarks successful source-checkout inspections through the CLI seam", async () => {
  const result = await execa(process.execPath, [
    "benchmarks/inspection-latency.ts",
    "--adapter",
    "source",
    "--iterations",
    "1",
    "--json",
  ]);

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "inspection-latency-benchmark",
    schemaVersion: 1,
    adapter: "source",
    iterations: 1,
    cases: [
      {
        analysisMaxRssBytes: { max: expect.any(Number) },
        name: "interface-overview",
        statuses: ["success"],
      },
      {
        analysisMaxRssBytes: { max: expect.any(Number) },
        name: "signature-inspection",
        statuses: ["success"],
      },
      {
        analysisMaxRssBytes: { max: expect.any(Number) },
        name: "export-search",
        statuses: ["success"],
      },
      {
        analysisMaxRssBytes: { max: expect.any(Number) },
        name: "public-subpath-discovery",
        statuses: ["success"],
      },
    ],
  });
});

it("measures agent protocol projection and recovery workloads", async () => {
  const result = await execa(process.execPath, ["benchmarks/agent-protocol.ts"]);

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "agent-protocol-benchmark",
    schemaVersion: 1,
    protocolVersion: "1",
    workloads: [
      {
        id: "execa-invocation",
        passed: true,
        reductionRatio: expect.any(Number),
      },
      {
        id: "execa-export-recovery",
        passed: true,
        recoveredStatus: "success",
      },
      {
        id: "execa-export-discovery",
        passed: true,
        matches: expect.arrayContaining(["ExecaError"]),
      },
    ],
  });
});

const passingLatencyCases = REQUIRED_LATENCY_CASES.map(passingLatencyCase);
const passingWorkloads = REQUIRED_AGENT_WORKLOADS.map(passingWorkload);
const signatureLatencyCase = passingLatencyCase("signature-inspection");
const payloadWorkload = passingWorkload("execa-invocation");
const passingMeasurements: BenchmarkMeasurements = {
  analysisMaxRssBytes: BENCHMARK_LIMITS.maxAnalysisRssBytes,
  cache: {
    identicalOutput: true,
    repeatedPhases: ["request-validation", "inspection-cache-hit", "analysis"],
  },
  packageArtifact: {
    runtimeBytes: BENCHMARK_LIMITS.maxRuntimePackageBytes,
    totalBytes: BENCHMARK_LIMITS.maxTotalPackageBytes,
  },
  packageLatencyCases: passingLatencyCases,
  workloads: passingWorkloads,
};

it("accepts measurements at every regression boundary", () => {
  expect(evaluateBenchmarkGates(passingMeasurements)).toMatchObject({
    kind: "benchmark-gate-report",
    passed: true,
    checks: [
      { name: "semantic-outcomes", passed: true },
      { name: "latency", passed: true },
      { name: "cache-hit", passed: true },
      { name: "analysis-memory", passed: true },
      { name: "package-size", passed: true },
      { name: "agent-workloads", passed: true },
      { name: "protocol-payload", passed: true },
    ],
  });
});

const failingMeasurements: readonly [BenchmarkGateCheck["name"], Partial<BenchmarkMeasurements>][] =
  [
    [
      "semantic-outcomes",
      {
        packageLatencyCases: passingLatencyCases.map((benchmarkCase) =>
          benchmarkCase.name === signatureLatencyCase.name
            ? { ...benchmarkCase, statuses: ["unsupported"] }
            : benchmarkCase,
        ),
      },
    ],
    [
      "latency",
      {
        packageLatencyCases: passingLatencyCases.map((benchmarkCase) =>
          benchmarkCase.name === signatureLatencyCase.name
            ? {
                ...benchmarkCase,
                wallMilliseconds: {
                  max: BENCHMARK_LIMITS.maxCaseWallMilliseconds + 1,
                  mean: BENCHMARK_LIMITS.maxCaseMeanWallMilliseconds + 1,
                },
              }
            : benchmarkCase,
        ),
      },
    ],
    ["cache-hit", { cache: { identicalOutput: false, repeatedPhases: [] } }],
    ["analysis-memory", { analysisMaxRssBytes: BENCHMARK_LIMITS.maxAnalysisRssBytes + 1 }],
    [
      "package-size",
      {
        packageArtifact: {
          ...passingMeasurements.packageArtifact,
          totalBytes: BENCHMARK_LIMITS.maxTotalPackageBytes + 1,
        },
      },
    ],
    [
      "agent-workloads",
      {
        workloads: passingWorkloads.map((workload) =>
          workload.id === payloadWorkload.id ? { ...workload, passed: false } : workload,
        ),
      },
    ],
    [
      "protocol-payload",
      {
        workloads: passingWorkloads.map((workload) =>
          workload.id === payloadWorkload.id
            ? {
                ...workload,
                structuredBytes:
                  BENCHMARK_LIMITS.maxStructuredToBothBytesRatio *
                    (payloadWorkload.bothBytes ?? 0) +
                  1,
              }
            : workload,
        ),
      },
    ],
  ];

it.each(failingMeasurements)("fails the %s gate when its boundary regresses", (name, overrides) => {
  const report = evaluateBenchmarkGates({ ...passingMeasurements, ...overrides });
  expect(report.passed).toBe(false);
  expect(report.checks).toContainEqual(expect.objectContaining({ name, passed: false }));
});

it("rejects omitted or duplicated required latency cases", () => {
  for (const packageLatencyCases of [
    passingLatencyCases.slice(1),
    [passingLatencyCase("interface-overview"), ...passingLatencyCases],
  ]) {
    const report = evaluateBenchmarkGates({ ...passingMeasurements, packageLatencyCases });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "semantic-outcomes", passed: false }),
        expect.objectContaining({ name: "latency", passed: false }),
      ]),
    );
  }
});

it("rejects omitted or duplicated required agent workloads", () => {
  for (const workloads of [
    passingWorkloads.slice(1),
    [passingWorkload("execa-invocation"), ...passingWorkloads],
  ]) {
    const report = evaluateBenchmarkGates({ ...passingMeasurements, workloads });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "agent-workloads", passed: false }),
        expect.objectContaining({ name: "protocol-payload", passed: false }),
      ]),
    );
  }
});

function passingLatencyCase(name: BenchmarkLatencyCaseName): BenchmarkLatencyCase {
  return {
    name,
    statuses: ["success", "success", "success"],
    wallMilliseconds: {
      max: BENCHMARK_LIMITS.maxCaseWallMilliseconds,
      mean: BENCHMARK_LIMITS.maxCaseMeanWallMilliseconds,
    },
  };
}

function passingWorkload(id: BenchmarkWorkloadId): BenchmarkWorkloadMeasurement {
  return id === "execa-invocation"
    ? {
        bothBytes: 1_000,
        id,
        passed: true,
        structuredBytes: BENCHMARK_LIMITS.maxStructuredToBothBytesRatio * 1_000,
      }
    : { id, passed: true };
}
