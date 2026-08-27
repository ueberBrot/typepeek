import { Schema } from "effect";

import { REQUIRED_LATENCY_CASES } from "./latency-workloads.ts";

export { REQUIRED_LATENCY_CASES } from "./latency-workloads.ts";

export const BENCHMARK_LIMITS = Object.freeze({
  maxAnalysisRssBytes: 512 * 1_024 * 1_024,
  maxCaseMeanWallMilliseconds: 8_000,
  maxCaseWallMilliseconds: 12_000,
  maxRuntimePackageBytes: 512 * 1_024,
  maxStructuredPayloadBytes: 4 * 1_024,
  maxStructuredToBothBytesRatio: 0.85,
  maxTotalPackageBytes: 1_500 * 1_024,
} as const);
export const REQUIRED_AGENT_WORKLOADS = [
  "execa-invocation",
  "execa-export-recovery",
  "execa-export-discovery",
] as const;
const REQUIRED_PAYLOAD_WORKLOADS = ["execa-invocation"] as const;

export type { BenchmarkLatencyCaseName } from "./latency-workloads.ts";
export type BenchmarkWorkloadId = (typeof REQUIRED_AGENT_WORKLOADS)[number];

const finiteNonNegativeSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const finitePositiveSchema = Schema.Finite.check(Schema.isGreaterThan(0));
const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const durationSummarySchema = Schema.Struct({
  min: finiteNonNegativeSchema,
  mean: finiteNonNegativeSchema,
  max: finiteNonNegativeSchema,
});
const latencyMeasurementSchema = Schema.Struct({
  name: Schema.Literals(REQUIRED_LATENCY_CASES),
  statuses: Schema.Array(Schema.String),
  wallMilliseconds: Schema.Struct({
    mean: finiteNonNegativeSchema,
    max: finiteNonNegativeSchema,
  }),
});
const workloadMeasurementSchema = Schema.Struct({
  id: Schema.Literals(REQUIRED_AGENT_WORKLOADS),
  passed: Schema.Boolean,
  structuredBytes: Schema.optional(finitePositiveSchema),
  bothBytes: Schema.optional(finitePositiveSchema),
});
const measurementsSchema = Schema.Struct({
  analysisMaxRssBytes: finitePositiveSchema,
  cache: Schema.Struct({
    identicalOutput: Schema.Boolean,
    repeatedPhases: Schema.Array(Schema.String),
  }),
  packageArtifact: Schema.Struct({
    runtimeBytes: finitePositiveSchema,
    totalBytes: finitePositiveSchema,
  }),
  packageLatencyCases: Schema.Array(latencyMeasurementSchema),
  workloads: Schema.Array(workloadMeasurementSchema),
});

const latencyCaseSchema = Schema.Struct({
  name: Schema.Literals(REQUIRED_LATENCY_CASES),
  statuses: Schema.Array(Schema.String),
  analysisMaxRssBytes: Schema.optional(durationSummarySchema),
  wallMilliseconds: durationSummarySchema,
  phases: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      milliseconds: durationSummarySchema,
    }),
  ),
});
export const inspectionLatencyReportSchema = Schema.Struct({
  kind: Schema.Literal("inspection-latency-benchmark"),
  schemaVersion: Schema.Literal(1),
  adapter: Schema.Literals(["build", "package", "source"]),
  iterations: positiveIntegerSchema,
  cases: Schema.Array(latencyCaseSchema),
});

const agentWorkloadBaseFields = {
  question: Schema.String,
  passed: Schema.Boolean,
  facts: Schema.Array(Schema.String),
};
const signatureProjectionWorkloadSchema = Schema.Struct({
  id: Schema.Literal("execa-invocation"),
  ...agentWorkloadBaseFields,
  structuredBytes: finitePositiveSchema,
  bothBytes: finitePositiveSchema,
  reductionRatio: finiteNonNegativeSchema,
});
const supportingTypeRecoveryWorkloadSchema = Schema.Struct({
  id: Schema.Literal("execa-export-recovery"),
  ...agentWorkloadBaseFields,
  initialStatus: Schema.String,
  recoveryReason: Schema.String,
  recoveredStatus: Schema.String,
});
const exportDiscoveryWorkloadSchema = Schema.Struct({
  id: Schema.Literal("execa-export-discovery"),
  ...agentWorkloadBaseFields,
  matches: Schema.Array(Schema.String),
});
export const agentProtocolReportSchema = Schema.Struct({
  kind: Schema.Literal("agent-protocol-benchmark"),
  schemaVersion: Schema.Literal(1),
  protocolVersion: Schema.Literal("1"),
  workloads: Schema.Array(
    Schema.Union([
      signatureProjectionWorkloadSchema,
      supportingTypeRecoveryWorkloadSchema,
      exportDiscoveryWorkloadSchema,
    ]),
  ),
});

const gateNameSchema = Schema.Literals([
  "semantic-outcomes",
  "latency",
  "cache-hit",
  "analysis-memory",
  "package-size",
  "agent-workloads",
  "protocol-payload",
]);
const gateCheckSchema = Schema.Struct({
  name: gateNameSchema,
  passed: Schema.Boolean,
});
const limitsSchema = Schema.Struct({
  maxAnalysisRssBytes: Schema.Literal(BENCHMARK_LIMITS.maxAnalysisRssBytes),
  maxCaseMeanWallMilliseconds: Schema.Literal(BENCHMARK_LIMITS.maxCaseMeanWallMilliseconds),
  maxCaseWallMilliseconds: Schema.Literal(BENCHMARK_LIMITS.maxCaseWallMilliseconds),
  maxRuntimePackageBytes: Schema.Literal(BENCHMARK_LIMITS.maxRuntimePackageBytes),
  maxStructuredPayloadBytes: Schema.Literal(BENCHMARK_LIMITS.maxStructuredPayloadBytes),
  maxStructuredToBothBytesRatio: Schema.Literal(BENCHMARK_LIMITS.maxStructuredToBothBytesRatio),
  maxTotalPackageBytes: Schema.Literal(BENCHMARK_LIMITS.maxTotalPackageBytes),
});
const benchmarkGateReportSchema = Schema.Struct({
  kind: Schema.Literal("benchmark-gate-report"),
  schemaVersion: Schema.Literal(1),
  passed: Schema.Boolean,
  limits: limitsSchema,
  measurements: measurementsSchema,
  checks: Schema.Array(gateCheckSchema),
});

export type BenchmarkLatencyCase = typeof latencyMeasurementSchema.Type;
export type BenchmarkWorkloadMeasurement = typeof workloadMeasurementSchema.Type;
export type BenchmarkMeasurements = typeof measurementsSchema.Type;
export type BenchmarkGateCheck = typeof gateCheckSchema.Type;
export type BenchmarkGateReport = typeof benchmarkGateReportSchema.Type;
export type InspectionLatencyReport = typeof inspectionLatencyReportSchema.Type;
export type AgentProtocolReport = typeof agentProtocolReportSchema.Type;

const encodeLatencyReport = Schema.encodeSync(inspectionLatencyReportSchema);
const encodeAgentReport = Schema.encodeSync(agentProtocolReportSchema);
const encodeGateReport = Schema.encodeSync(benchmarkGateReportSchema);

export function encodeInspectionLatencyReport(report: InspectionLatencyReport): unknown {
  return encodeLatencyReport(report);
}

export function encodeAgentProtocolReport(report: AgentProtocolReport): unknown {
  return encodeAgentReport(report);
}

export function encodeBenchmarkGateReport(report: BenchmarkGateReport): unknown {
  return encodeGateReport(report);
}

export function evaluateBenchmarkGates(measurements: BenchmarkMeasurements): BenchmarkGateReport {
  const latencyCoverage = hasRequiredIdentities(
    measurements.packageLatencyCases,
    REQUIRED_LATENCY_CASES,
    ({ name }) => name,
  );
  const workloadCoverage = hasRequiredIdentities(
    measurements.workloads,
    REQUIRED_AGENT_WORKLOADS,
    ({ id }) => id,
  );
  const payloadWorkloads = measurements.workloads.filter(isRequiredPayloadMeasurement);
  const payloadCoverage = hasRequiredIdentities(
    payloadWorkloads,
    REQUIRED_PAYLOAD_WORKLOADS,
    ({ id }) => id,
  );
  const checks: readonly BenchmarkGateCheck[] = [
    {
      name: "semantic-outcomes",
      passed:
        latencyCoverage &&
        measurements.packageLatencyCases.every(
          ({ statuses }) => statuses.length > 0 && statuses.every((status) => status === "success"),
        ),
    },
    {
      name: "latency",
      passed:
        latencyCoverage &&
        measurements.packageLatencyCases.every(
          ({ wallMilliseconds }) =>
            isBoundedMeasurement(
              wallMilliseconds.mean,
              BENCHMARK_LIMITS.maxCaseMeanWallMilliseconds,
            ) &&
            isBoundedMeasurement(wallMilliseconds.max, BENCHMARK_LIMITS.maxCaseWallMilliseconds),
        ),
    },
    {
      name: "cache-hit",
      passed:
        measurements.cache.identicalOutput &&
        measurements.cache.repeatedPhases.includes("inspection-cache-hit") &&
        !measurements.cache.repeatedPhases.includes("program-materialization"),
    },
    {
      name: "analysis-memory",
      passed: isBoundedMeasurement(
        measurements.analysisMaxRssBytes,
        BENCHMARK_LIMITS.maxAnalysisRssBytes,
      ),
    },
    {
      name: "package-size",
      passed:
        isBoundedMeasurement(
          measurements.packageArtifact.runtimeBytes,
          BENCHMARK_LIMITS.maxRuntimePackageBytes,
        ) &&
        isBoundedMeasurement(
          measurements.packageArtifact.totalBytes,
          BENCHMARK_LIMITS.maxTotalPackageBytes,
        ),
    },
    {
      name: "agent-workloads",
      passed: workloadCoverage && measurements.workloads.every(({ passed }) => passed),
    },
    {
      name: "protocol-payload",
      passed:
        payloadCoverage &&
        payloadWorkloads.every(
          ({ bothBytes, structuredBytes }) =>
            isBoundedMeasurement(structuredBytes, BENCHMARK_LIMITS.maxStructuredPayloadBytes) &&
            structuredBytes <= bothBytes * BENCHMARK_LIMITS.maxStructuredToBothBytesRatio,
        ),
    },
  ];
  return {
    kind: "benchmark-gate-report",
    schemaVersion: 1,
    passed: checks.every(({ passed }) => passed),
    limits: BENCHMARK_LIMITS,
    measurements,
    checks,
  };
}

function hasRequiredIdentities<Value, Identity extends string>(
  values: readonly Value[],
  required: readonly Identity[],
  identityOf: (value: Value) => string,
): boolean {
  const counts = new Map<string, number>();
  for (const value of values) {
    const identity = identityOf(value);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return required.every((identity) => counts.get(identity) === 1);
}

function hasPayloadMeasurement(
  workload: BenchmarkWorkloadMeasurement,
): workload is BenchmarkWorkloadMeasurement & {
  readonly structuredBytes: number;
  readonly bothBytes: number;
} {
  return workload.structuredBytes !== undefined && workload.bothBytes !== undefined;
}

function isRequiredPayloadMeasurement(
  workload: BenchmarkWorkloadMeasurement,
): workload is BenchmarkWorkloadMeasurement & {
  readonly structuredBytes: number;
  readonly bothBytes: number;
} {
  return workload.id === "execa-invocation" && hasPayloadMeasurement(workload);
}

function isBoundedMeasurement(value: number, maximum: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= maximum;
}
