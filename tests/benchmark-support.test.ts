import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/shared/defined-value";

import { inspectWithCompiler } from "../benchmarks/support/compiler.ts";
import {
  comparePairedObservations,
  seededRandom,
  shuffled,
  summarizeObservations,
} from "../benchmarks/support/statistics.ts";
import { selectDiscoveryWorkloads } from "../benchmarks/support/workloads.ts";

describe("benchmark-support", () => {
  it("resolves Node declarations only from a separate consumer snapshot", async () => {
    const workspace = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "discovery-oracle-"))
    );

    const require = createRequire(import.meta.url);

    try {
      await mkdir(nodePath.join(workspace, "node_modules", "@types"), {
        recursive: true,
      });
      await writeFile(
        nodePath.join(workspace, "package.json"),
        '{"type":"module"}'
      );
      await cp(
        nodePath.dirname(require.resolve("@types/node/package.json")),
        nodePath.join(workspace, "node_modules", "@types", "node"),
        { recursive: true }
      );
      await cp(
        nodePath.dirname(
          require.resolve("undici-types/package.json", {
            paths: [
              nodePath.dirname(require.resolve("@types/node/package.json")),
            ],
          })
        ),
        nodePath.join(workspace, "node_modules", "undici-types"),
        { recursive: true }
      );

      const answer = await inspectWithCompiler(
        workspace,
        requireDefined(selectDiscoveryWorkloads("node-exists")[0])
      );

      expect(answer.facts).toStrictEqual([
        "call:( path : PathLike ) : boolean",
      ]);

      const nodeFiles = answer.files.filter((file) =>
        file.includes("/@types/node/")
      );

      expect([
        nodeFiles.length > 0,
        nodeFiles.every((file) => file.startsWith(workspace)),
      ]).toStrictEqual([true, true]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("reports sample variability and uncertainty without deleting slow observations", () => {
    const summary = summarizeObservations([90, 95, 100, 105, 110]);
    expect(summary).toMatchObject({
      count: 5,
      max: 110,
      mean: 100,
      median: 100,
      min: 90,
      p95: 109,
    });
    expect(summary.standardDeviation).toBeCloseTo(7.905694, 5);
    expect(summary.meanCi95HalfWidth).toBeCloseTo(9.814642, 4);
    expect([
      summarizeObservations([10, 10, 10, 10, 1000]).max,
      summarizeObservations([100]).meanCi95HalfWidth === null,
    ]).toStrictEqual([1000, true]);

    for (const samples of [[], [0], [-1], [Number.NaN], [Infinity]]) {
      expect(() => summarizeObservations(samples)).toThrow(/./u);
    }
  });

  it("reproduces scheduling and paired uncertainty from the seed and recorded samples", () => {
    expect(shuffled([1, 2, 3, 4], seededRandom(42))).toStrictEqual(
      shuffled([1, 2, 3, 4], seededRandom(42))
    );
    const baseline = [200, 240, 180, 300, 220];
    const treatment = [100, 120, 90, 150, 110];
    expect([
      comparePairedObservations(baseline, treatment, 1729),
      comparePairedObservations([10], [20], 1729).ratioCi95 === null,
    ]).toStrictEqual([
      {
        medianRatio: 2,
        medianSaved: 110,
        ratioCi95: [2, 2],
      },
      true,
    ]);
    expect(() => comparePairedObservations([10], [10, 20], 1729)).toThrow(/./u);
  });
});
