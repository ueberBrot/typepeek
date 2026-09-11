import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";

import { inspectWithCompiler } from "../benchmarks/support/compiler.ts";
import {
  comparePairedObservations,
  seededRandom,
  shuffled,
  summarizeObservations,
} from "../benchmarks/support/statistics.ts";
import { selectDiscoveryWorkloads } from "../benchmarks/support/workloads.ts";

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

it("reports sample variability and uncertainty without deleting slow observations", () => {
  const summary = summarizeObservations([90, 95, 100, 105, 110]);
  expect(summary).toMatchObject({ count: 5, min: 90, median: 100, max: 110, mean: 100, p95: 109 });
  expect(summary.standardDeviation).toBeCloseTo(7.905694, 5);
  expect(summary.meanCi95HalfWidth).toBeCloseTo(9.814642, 4);
  expect(summarizeObservations([10, 10, 10, 10, 1000]).max).toBe(1000);
  expect(summarizeObservations([100]).meanCi95HalfWidth).toBeNull();
  for (const samples of [[], [0], [-1], [NaN], [Infinity]]) {
    expect(() => summarizeObservations(samples)).toThrow();
  }
});

it("reproduces scheduling and paired uncertainty from the seed and recorded samples", () => {
  expect(shuffled([1, 2, 3, 4], seededRandom(42))).toEqual(
    shuffled([1, 2, 3, 4], seededRandom(42)),
  );
  const baseline = [200, 240, 180, 300, 220];
  const treatment = [100, 120, 90, 150, 110];
  expect(comparePairedObservations(baseline, treatment, 1729)).toEqual({
    medianRatio: 2,
    ratioCi95: [2, 2],
    medianSaved: 110,
  });
  expect(comparePairedObservations([10], [20], 1729).ratioCi95).toBeNull();
  expect(() => comparePairedObservations([10], [10, 20], 1729)).toThrow();
});
