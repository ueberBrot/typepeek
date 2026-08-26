import { Result, Schema } from "effect";
import { execa } from "execa";
import type { Dirent } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { decodeInspectionProfile } from "#typepeek/inspection/performance-profile";

import {
  agentProtocolReportSchema,
  type BenchmarkMeasurements,
  encodeBenchmarkGateReport,
  evaluateBenchmarkGates,
  inspectionLatencyReportSchema,
} from "./regression-policy.ts";

const decodeLatencyReport = Schema.decodeUnknownResult(inspectionLatencyReportSchema);
const decodeAgentProtocolReport = Schema.decodeUnknownResult(agentProtocolReportSchema);

const packageLatency = await runLatencyBenchmark("package", 3);
const sourceMemory = await runLatencyBenchmark("source", 1);
const cache = await measureCacheHit();
const agentProtocol = await runAgentProtocolBenchmark();
const packageArtifact = await measurePublishedPackage();

const measurements: BenchmarkMeasurements = {
  analysisMaxRssBytes: Math.max(
    ...sourceMemory.cases.map(({ analysisMaxRssBytes }) => analysisMaxRssBytes?.max ?? 0),
  ),
  cache,
  packageArtifact,
  packageLatencyCases: packageLatency.cases,
  workloads: agentProtocol.workloads,
};
const report = evaluateBenchmarkGates(measurements);
process.stdout.write(`${JSON.stringify(encodeBenchmarkGateReport(report))}\n`);
if (!report.passed) {
  process.exitCode = 1;
}

async function runLatencyBenchmark(adapter: "package" | "source", iterations: number) {
  const result = await execa(process.execPath, [
    "benchmarks/inspection-latency.ts",
    "--adapter",
    adapter,
    "--iterations",
    String(iterations),
    "--json",
  ]);
  return decodeJson(result.stdout, decodeLatencyReport, `${adapter} latency benchmark`);
}

async function runAgentProtocolBenchmark() {
  const result = await execa(process.execPath, ["benchmarks/agent-protocol.ts"]);
  return decodeJson(result.stdout, decodeAgentProtocolReport, "agent protocol benchmark");
}

async function measureCacheHit(): Promise<BenchmarkMeasurements["cache"]> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-benchmark-cache-"));
  const arguments_ = [
    "src/cli.ts",
    "signatures",
    "execa",
    "execa",
    "--context",
    resolve("."),
    "--json",
  ];
  const env = {
    TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
    TYPEPEEK_PROFILE: "1",
  };
  try {
    const first = await execa(process.execPath, arguments_, { env });
    const repeated = await execa(process.execPath, arguments_, { env });
    const profile = decodeInspectionProfile(repeated.stderr);
    if (profile === undefined) {
      throw new TypeError("Invalid cache-hit inspection profile output.");
    }
    return {
      identicalOutput: repeated.stdout === first.stdout,
      repeatedPhases: profile.phases.map(({ name }) => name),
    };
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

async function measurePublishedPackage(): Promise<BenchmarkMeasurements["packageArtifact"]> {
  const dist = await measureDirectory("dist");
  const rootBytes = await Promise.all(
    ["package.json", "README.md"].map(async (path) => (await stat(path)).size),
  );
  return {
    runtimeBytes: dist.runtimeBytes,
    totalBytes: dist.totalBytes + rootBytes.reduce((sum, bytes) => sum + bytes, 0),
  };
}

async function measureDirectory(directory: string): Promise<{
  readonly runtimeBytes: number;
  readonly totalBytes: number;
}> {
  let runtimeBytes = 0;
  let totalBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = await measurePublishedEntry(directory, entry);
    runtimeBytes += child.runtimeBytes;
    totalBytes += child.totalBytes;
  }
  return { runtimeBytes, totalBytes };
}

async function measurePublishedEntry(
  directory: string,
  entry: Dirent<string>,
): Promise<{ readonly runtimeBytes: number; readonly totalBytes: number }> {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) {
    return measureDirectory(path);
  }
  if (!entry.isFile()) {
    throw new TypeError(`Published artifact contains a non-file entry: ${path}`);
  }
  const bytes = (await stat(path)).size;
  return {
    runtimeBytes: entry.name.endsWith(".js") ? bytes : 0,
    totalBytes: bytes,
  };
}

function decodeJson<Value>(
  serialized: string,
  decode: (value: unknown) => Result.Result<Value, unknown>,
  label: string,
): Value {
  const value: unknown = JSON.parse(serialized);
  return Result.getOrThrowWith(
    decode(value),
    (cause) => new TypeError(`Invalid ${label} output.`, { cause }),
  );
}
