import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { reserveDiscoveryArtifacts } from "./artifacts.ts";
import { inspectWithCompiler } from "./compiler.ts";
import { decodeCompilerAnswer, decodeFileEvidence, fileFacts, typepeekFacts } from "./evidence.ts";
import {
  currentEvidenceFingerprint,
  discoveryIdentity,
  evidenceFingerprint,
  hashText,
  requirePackagedArtifact,
} from "./identity.ts";
import {
  decodeDiscoveryRun,
  type DiscoveryCondition,
  type DiscoveryOptions,
  type DiscoveryRow,
  type DiscoveryRun,
  type DiscoverySample,
  evaluateDiscoveryRun,
  renderDiscoveryReport,
} from "./report.ts";
import { seededRandom, shuffled } from "./statistics.ts";
import {
  discoveryCliArguments,
  type DiscoveryWorkload,
  selectDiscoveryWorkloads,
} from "./workloads.ts";

const options = readOptions();
const workloads = selectDiscoveryWorkloads(options.caseId);
const artifacts = await reserveDiscoveryArtifacts(options.output);
let packagedCli: string;
let cacheDirectory: string | undefined;
try {
  packagedCli = requirePackagedArtifact();
  cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-discovery-cache-"));
  await runBenchmark();
} finally {
  await artifacts.close();
  if (cacheDirectory !== undefined) await rm(cacheDirectory, { recursive: true, force: true });
}

async function runBenchmark(): Promise<void> {
  const baseline =
    options.compare === undefined
      ? undefined
      : decodeDiscoveryRun(JSON.parse(await readFile(options.compare, "utf8")));
  const expected = new Map(
    workloads.map((workload) => [workload.id, inspectWithCompiler(options.workspace, workload)]),
  );
  const initialEvidence = evidenceFingerprint(
    options.workspace,
    [...expected.values()].flatMap(({ files }) => files),
  );
  const identity = await discoveryIdentity({
    workspace: options.workspace,
    compilerVersion: [...expected.values()][0]!.compilerVersion,
    evidenceHash: initialEvidence,
  });
  const rows: DiscoveryRow[] = [];
  const random = seededRandom(options.seed);
  for (const workload of workloads) {
    const facts = expected.get(workload.id)!.facts;
    const conditions: DiscoveryCondition[] = [
      ...(workload.filesPackage === undefined ? [] : ["files" as const]),
      "compiler",
      "typepeek-cold",
      "typepeek-warm",
    ];
    const samples = new Map(conditions.map((condition) => [condition, [] as DiscoverySample[]]));
    const prewarm = await measure(workload, "typepeek-warm", facts, 0, "cache-prime");
    if (!prewarm.passed)
      process.stderr.write(`${workload.id}: cache priming failed: ${prewarm.error}\n`);
    const order = shuffled(conditions, random);
    for (let iteration = -options.warmups; iteration < options.iterations; iteration += 1) {
      const offset = (iteration + options.warmups) % order.length;
      for (const condition of [...order.slice(offset), ...order.slice(0, offset)]) {
        const sample = await measure(
          workload,
          condition,
          facts,
          Math.max(0, iteration),
          iteration < 0 ? "warmup" : "measurement",
        );
        if (iteration >= 0) samples.get(condition)!.push(sample);
      }
    }
    for (const condition of conditions) {
      rows.push({
        workload: workload.id,
        condition,
        question: workload.question,
        expectedFacts: facts,
        samples: samples.get(condition)!,
      });
    }
    process.stderr.write(
      `Measured ${workload.id}: ${options.iterations} repetitions × ${conditions.length} methods.\n`,
    );
  }
  const finalEvidence = currentEvidenceFingerprint(options.workspace, workloads);
  const finalIdentity = await discoveryIdentity({
    workspace: options.workspace,
    compilerVersion: identity.compiler,
    evidenceHash: finalEvidence,
  });
  const run: DiscoveryRun = {
    kind: "discovery-benchmark",
    schemaVersion: 2,
    workloads: workloads.map(({ id }) => id),
    recordedAt: new Date().toISOString(),
    identity,
    options: {
      iterations: options.iterations,
      warmups: options.warmups,
      seed: options.seed,
      timeoutMs: options.timeoutMs,
      tolerancePercent: options.tolerancePercent,
      toleranceMs: options.toleranceMs,
      maxCvPercent: options.maxCvPercent,
    },
    evidenceUnchanged: finalEvidence === initialEvidence,
    inputsUnchanged: ["lockfileHash", "artifactHash", "harnessHash"].every(
      (key) =>
        identity[key as keyof typeof identity] === finalIdentity[key as keyof typeof finalIdentity],
    ),
    rows,
  };
  const evaluation = evaluateDiscoveryRun(run, baseline);
  const serialized = `${JSON.stringify({ ...run, evaluation }, null, 2)}\n`;
  await artifacts.writeReport(serialized);
  process.stdout.write(
    options.json
      ? serialized
      : renderDiscoveryReport(run, evaluation, options.check || baseline !== undefined),
  );
  if (
    !evaluation.correctness ||
    !evaluation.baselineCompatible ||
    ((options.check || baseline !== undefined) && !evaluation.passed)
  ) {
    process.exitCode = 1;
  }
}

async function measure(
  workload: DiscoveryWorkload,
  condition: DiscoveryCondition,
  expectedFacts: readonly string[],
  iteration: number,
  phase: string,
): Promise<DiscoverySample> {
  const arguments_ =
    condition === "files" || condition === "compiler"
      ? [resolve(`benchmarks/discovery/${condition}-worker.ts`), options.workspace, workload.id]
      : [packagedCli, ...discoveryCliArguments(workload), "--workspace", options.workspace];
  const started = performance.now();
  const result = await execa(process.execPath, arguments_, {
    cwd: options.workspace,
    reject: false,
    timeout: options.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      TYPEPEEK_CACHE_BYPASS: condition === "typepeek-warm" ? "0" : "1",
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "0",
      NODE_OPTIONS: "",
    },
  });
  const milliseconds = performance.now() - started;
  let facts: readonly string[] | null = null;
  let error: string | null = null;
  let toolCalls = 1;
  try {
    if (result.failed)
      throw new Error(result.shortMessage ?? `Process exited ${result.exitCode}: ${result.stderr}`);
    facts =
      condition === "compiler"
        ? decodeCompilerAnswer(JSON.parse(result.stdout)).facts
        : condition === "files"
          ? fileFacts(workload, result.stdout)
          : typepeekFacts(workload, result.stdout);
    if (condition === "files")
      toolCalls = decodeFileEvidence(JSON.parse(result.stdout)).commands.length;
    if (JSON.stringify(facts) !== JSON.stringify(expectedFacts)) {
      throw new Error(
        `Evidence differs from independent compiler oracle. Expected ${JSON.stringify(expectedFacts)}; received ${JSON.stringify(facts)}.`,
      );
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const sample: DiscoverySample = {
    iteration,
    milliseconds,
    stdoutBytes: Buffer.byteLength(result.stdout),
    passed: error === null,
    error,
    factsHash: facts === null ? null : hashText(JSON.stringify(facts)),
    toolCalls,
  };
  await artifacts.appendTrace({
    workload: workload.id,
    condition,
    phase,
    command: [process.execPath, ...arguments_],
    sample,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return sample;
}

function readOptions(): DiscoveryOptions & {
  readonly workspace: string;
  readonly caseId: string | undefined;
  readonly compare: string | undefined;
  readonly output: string;
  readonly json: boolean;
  readonly check: boolean;
} {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: node benchmarks/discovery/run.ts [options]

  --workspace PATH          Installed consumer with a lockfile (default: .)
  --case ID                 One workload; omit for all ten
  --iterations N            Measured repetitions, 1–200 (default: 15)
  --warmups N               Excluded warmups, 0–20 (default: 2)
  --seed N                  Fixed condition ordering and bootstrap seed (default: 1729)
  --timeout-ms N            Per-process deadline (default: 15000)
  --output PATH             Save new JSON and PATH.traces.jsonl (default: unique .benchmarks/discovery run)
  --compare PATH            Compare a compatible prior JSON run; enforce gate
  --tolerance-percent N     Allowed median regression (default: 10)
  --tolerance-ms N          Absolute tolerance floor (default: 10)
  --max-cv-percent N        Maximum sample variability for gate (default: 20)
  --check                   Require correctness and stable timings (at least 5 samples)
  --json                    Print JSON instead of the human report

Correctness failures always exit 1. Comparison tolerance is max(percent, milliseconds).
Model inference is not part of these deterministic retrieval replays.
Requires prepacked dist/cli.js. Run vp run pack separately; packing is never part of a benchmark.
`);
    process.exit(0);
  }
  const { values } = parseArgs({
    options: {
      workspace: { type: "string", default: "." },
      case: { type: "string" },
      iterations: { type: "string", default: "15" },
      warmups: { type: "string", default: "2" },
      seed: { type: "string", default: "1729" },
      "timeout-ms": { type: "string", default: "15000" },
      "tolerance-percent": { type: "string", default: "10" },
      "tolerance-ms": { type: "string", default: "10" },
      "max-cv-percent": { type: "string", default: "20" },
      compare: { type: "string" },
      output: {
        type: "string",
        default: `.benchmarks/discovery/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
      },
      json: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });
  return {
    workspace: resolve(values.workspace),
    caseId: values.case,
    compare: values.compare,
    output: values.output,
    json: values.json,
    check: values.check,
    iterations: integer(values.iterations, "iterations", 1, 200),
    warmups: integer(values.warmups, "warmups", 0, 20),
    seed: integer(values.seed, "seed", 0, 4_294_967_295),
    timeoutMs: integer(values["timeout-ms"], "timeout-ms", 100, 120_000),
    tolerancePercent: integer(values["tolerance-percent"], "tolerance-percent", 0, 100),
    toleranceMs: integer(values["tolerance-ms"], "tolerance-ms", 0, 10_000),
    maxCvPercent: integer(values["max-cv-percent"], "max-cv-percent", 1, 100),
  };
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`--${name} must be an integer in [${minimum}, ${maximum}].`);
  }
  return parsed;
}
