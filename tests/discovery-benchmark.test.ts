import { execa } from "execa";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";

import { inspectWithCompiler } from "../benchmarks/discovery/compiler.ts";
import { fileFacts, typepeekFacts } from "../benchmarks/discovery/evidence.ts";
import { type DiscoveryRun, evaluateDiscoveryRun } from "../benchmarks/discovery/report.ts";
import {
  comparePairedTimings,
  seededRandom,
  shuffled,
  summarizeTimings,
} from "../benchmarks/discovery/statistics.ts";
import { selectDiscoveryWorkloads } from "../benchmarks/discovery/workloads.ts";

it("resolves Node declarations only from a separate consumer snapshot", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "discovery-oracle-")));
  const require = createRequire(import.meta.url);
  try {
    await mkdir(join(workspace, "node_modules", "@types"), { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"type":"module"}');
    await cp(
      dirname(require.resolve("@types/node/package.json")),
      join(workspace, "node_modules", "@types", "node"),
      { recursive: true },
    );
    await cp(
      dirname(
        require.resolve("undici-types/package.json", {
          paths: [dirname(require.resolve("@types/node/package.json"))],
        }),
      ),
      join(workspace, "node_modules", "undici-types"),
      { recursive: true },
    );
    const answer = inspectWithCompiler(workspace, selectDiscoveryWorkloads("node-exists")[0]!);
    expect(answer.facts).toEqual(["call:( path : PathLike ) : boolean"]);
    const nodeFiles = answer.files.filter((file) => file.includes("/@types/node/"));
    expect(nodeFiles.length).toBeGreaterThan(0);
    expect(nodeFiles.every((file) => file.startsWith(workspace))).toBe(true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("collapses repeated ESM/CJS interfaces without removing overloads inside a declaration", () => {
  const workload = selectDiscoveryWorkloads("stricli-routes")[0]!;
  const text = "declare function buildRouteMap(route: string): string;";
  const evidence = (texts: string[]) =>
    JSON.stringify({
      files: texts.map((text, i) => ({ path: `index-${i}.d.ts`, text })),
      commands: [],
    });
  expect(fileFacts(workload, evidence([text, text]))).toHaveLength(1);
  expect(fileFacts(workload, evidence([text + text, text + text]))).toHaveLength(2);
});

it("reports sample variability and uncertainty without deleting slow observations", () => {
  const summary = summarizeTimings([90, 95, 100, 105, 110]);
  expect(summary).toMatchObject({ count: 5, min: 90, median: 100, max: 110, mean: 100, p95: 109 });
  expect(summary.standardDeviation).toBeCloseTo(7.905694, 5);
  expect(summary.meanCi95HalfWidth).toBeCloseTo(9.814642, 4);
  expect(summarizeTimings([10, 10, 10, 10, 1000]).max).toBe(1000);
  expect(summarizeTimings([100]).meanCi95HalfWidth).toBeNull();
  for (const samples of [[], [0], [-1], [NaN], [Infinity]]) {
    expect(() => summarizeTimings(samples)).toThrow();
  }
});

it("reproduces scheduling and paired uncertainty from the seed and recorded samples", () => {
  expect(shuffled([1, 2, 3, 4], seededRandom(42))).toEqual(
    shuffled([1, 2, 3, 4], seededRandom(42)),
  );
  const baseline = [200, 240, 180, 300, 220];
  const treatment = [100, 120, 90, 150, 110];
  expect(comparePairedTimings(baseline, treatment, 1729)).toEqual({
    medianSpeedup: 2,
    speedupCi95: [2, 2],
    medianSavedMilliseconds: 110,
  });
  expect(comparePairedTimings([10], [20], 1729).speedupCi95).toBeNull();
  expect(() => comparePairedTimings([10], [10, 20], 1729)).toThrow();
});

function runWithTimings(
  timings: readonly number[],
  overrides: Partial<DiscoveryRun> = {},
): DiscoveryRun {
  return {
    kind: "discovery-benchmark",
    schemaVersion: 1,
    recordedAt: "2026-09-08T00:00:00.000Z",
    identity: {
      workspace: "/consumer",
      node: "v24.18.0",
      compiler: "6.0.3",
      ripgrep: "15.2.0",
      platform: "linux",
      architecture: "x64",
      osRelease: "test",
      cpu: "test",
      hostname: "runner",
      adapter: "package",
      evidenceHash: "evidence",
      lockfileHash: "lock",
      artifactHash: "build",
      harnessHash: "harness",
      commit: "commit",
    },
    options: {
      iterations: timings.length,
      warmups: 2,
      seed: 1729,
      timeoutMs: 15000,
      tolerancePercent: 10,
      toleranceMs: 10,
      maxCvPercent: 20,
    },
    evidenceUnchanged: true,
    inputsUnchanged: true,
    rows: ["compiler", "typepeek-cold", "typepeek-warm"].map((condition) => ({
      workload: "test",
      condition: condition as "compiler" | "typepeek-cold" | "typepeek-warm",
      question: "Find the export",
      expectedFacts: ["answer"],
      samples: timings.map((milliseconds, iteration) => ({
        iteration,
        milliseconds,
        stdoutBytes: 100,
        passed: true,
        error: null,
        factsHash: "answer-hash",
        toolCalls: 1,
      })),
    })),
    ...overrides,
  };
}

it("uses the larger absolute or relative tolerance and rejects regressions beyond it", () => {
  const baseline = runWithTimings([100, 100, 100, 100, 100]);
  expect(evaluateDiscoveryRun(runWithTimings([110, 110, 110, 110, 110]), baseline).passed).toBe(
    true,
  );
  expect(evaluateDiscoveryRun(runWithTimings([111, 111, 111, 111, 111]), baseline).passed).toBe(
    false,
  );
  const small = runWithTimings([20, 20, 20, 20, 20]);
  expect(evaluateDiscoveryRun(runWithTimings([30, 30, 30, 30, 30]), small).passed).toBe(true);
});

it("rejects incorrect, noisy, insufficient, mutated, or incomparable benchmark data", () => {
  const baseline = runWithTimings([100, 100, 100, 100, 100]);
  expect(evaluateDiscoveryRun(runWithTimings([100]), baseline).passed).toBe(false);
  expect(evaluateDiscoveryRun(runWithTimings([10, 10, 10, 10, 1000]), baseline).stable).toBe(false);
  expect(
    evaluateDiscoveryRun({ ...baseline, evidenceUnchanged: false }, baseline).correctness,
  ).toBe(false);
  expect(
    evaluateDiscoveryRun(
      { ...baseline, identity: { ...baseline.identity, evidenceHash: "changed" } },
      baseline,
    ).baselineCompatible,
  ).toBe(false);
  expect(
    evaluateDiscoveryRun({ ...baseline, rows: baseline.rows.slice(1) }, baseline)
      .baselineCompatible,
  ).toBe(false);
  const failed = {
    ...baseline,
    rows: baseline.rows.map((row) => ({
      ...row,
      samples: row.samples.map((sample) => ({ ...sample, passed: false, error: "wrong overload" })),
    })),
  };
  const evaluation = evaluateDiscoveryRun(failed, baseline);
  expect(evaluation.correctness).toBe(false);
  expect(evaluation.comparisons.every((row) => row.comparison === null)).toBe(true);
  expect(evaluateDiscoveryRun(baseline, failed).baselineCompatible).toBe(false);
});

it("grades complete signatures while accepting optional declaration syntax", () => {
  const workload = selectDiscoveryWorkloads("execa-command")[0]!;
  const files = JSON.stringify({
    files: [
      {
        path: "index.d.ts",
        text: "export function parseCommandString(command: string,): string[];",
      },
    ],
    commands: [],
  });
  const outcome = (text: string) =>
    JSON.stringify({
      status: "success",
      result: {
        intent: "signature-inspection",
        specifier: "execa",
        moduleExport: { name: "parseCommandString", signatures: [{ kind: "call", text }] },
      },
    });
  expect(fileFacts(workload, files)).toEqual(
    typepeekFacts(workload, outcome("(command: string): string[]")),
  );
  expect(fileFacts(workload, files)).not.toEqual(
    typepeekFacts(workload, outcome("(command: string): {}")),
  );
  expect(() => typepeekFacts(workload, '{"status":"limit-exceeded"}')).toThrow();
});

it("rejects source execution before starting a benchmark", async () => {
  const result = await execa(
    process.execPath,
    ["benchmarks/discovery/run.ts", "--adapter", "source"],
    { reject: false },
  );
  expect(result.failed).toBe(true);
  expect(result.stderr).toContain("Unknown option '--adapter'");
});
