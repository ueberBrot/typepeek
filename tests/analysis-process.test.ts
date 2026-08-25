import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { runAnalysisFixtureProcess } from "#typepeek/inspection/analysis-process";
import type { AnalysisRequest } from "#typepeek/inspection/protocol";

const request: AnalysisRequest = {
  intent: "interface-overview",
  request: {
    resolutionContext: "/fixture",
    specifier: "fixture",
    accessStyle: "import",
  },
};
const limits = {
  // Leave process startup headroom when the full suite saturates CI workers.
  deadlineMilliseconds: 2_000,
  maxHeapMegabytes: 32,
  maxResultBytes: 1_024,
  maxDiagnosticBytes: 1_024,
};
const timeoutLimits = { ...limits, deadlineMilliseconds: 500 };

let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-analysis-process-"));
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

it("accepts exactly one bounded result from a cleanly exited analysis process", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() =>
        materializeProcessEntry(
          "success",
          `process.once("message", () => {
            process.stdout.write(JSON.stringify({status:"not-found", reason:"specifier-not-found", message:"bounded absence"}));
            process.disconnect();
          });`,
        ),
      );

      const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
      expect(outcome).toEqual({
        status: "not-found",
        reason: "specifier-not-found",
        message: "bounded absence",
      });
    }),
  ));

it.each([
  {
    name: "never responds",
    source: `process.once("message", () => setInterval(() => {}, 1_000));`,
  },
  {
    name: "sends a plausible result but never exits",
    source: `process.once("message", () => {
      process.stdout.write(JSON.stringify({status:"not-found", message:"partial"}));
      setInterval(() => {}, 1_000);
    });`,
  },
])("kills an analysis process that $name", async ({ name, source }) => {
  const entry = await materializeProcessEntry(name, source);

  await expect(runFixtureProcess(request, entry, timeoutLimits)).resolves.toEqual({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "analysis-deadline",
    message: "Inspection exceeded its analysis deadline.",
  });
});

it("rejects a terminated analysis process without an authoritative result", async () => {
  const entry = await materializeProcessEntry(
    "terminated",
    `process.once("message", () => process.exit(23));`,
  );

  await expect(runFixtureProcess(request, entry, limits)).resolves.toEqual({
    status: "unsupported",
    reason: "analysis-terminated",
    message: "Inspection analysis terminated before completion.",
  });
});

it.each([
  ["no result", `process.once("message", () => process.disconnect());`],
  [
    "malformed result",
    `process.once("message", () => { process.stdout.write("{not-json"); process.disconnect(); });`,
  ],
])("rejects a clean exit with $name", async (_name, source) => {
  const entry = await materializeProcessEntry(_name, source);

  await expect(runFixtureProcess(request, entry, limits)).resolves.toEqual({
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection could not validate the analysis process result.",
  });
});

it("rejects multiple analysis results instead of choosing a partial result", async () => {
  const entry = await materializeProcessEntry(
    "duplicate",
    `process.once("message", () => {
      process.stdout.write(JSON.stringify({status:"not-found", message:"first"}));
      process.stdout.write(JSON.stringify({status:"not-found", message:"second"}));
      process.disconnect();
    });`,
  );

  await expect(runFixtureProcess(request, entry, limits)).resolves.toEqual({
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection could not validate the analysis process result.",
  });
});

it("rejects analysis transport output beyond its measured budget", async () => {
  const entry = await materializeProcessEntry(
    "oversized",
    `process.once("message", () => {
      process.stdout.write(JSON.stringify({status:"not-found", message:"x".repeat(2_000)}));
      process.disconnect();
    });`,
  );

  await expect(runFixtureProcess(request, entry, limits)).resolves.toEqual({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "analysis-output-bytes",
    message: "Inspection exceeded its analysis process output limit.",
  });
});

it("accepts a valid result exactly at the transport byte boundary", async () => {
  const entry = await materializeProcessEntry(
    "exact-output-boundary",
    `process.once("message", () => {
      const prefix = '{"status":"not-found","reason":"specifier-not-found","message":"';
      const suffix = '"}';
      process.stdout.write(prefix + "x".repeat(1024 - Buffer.byteLength(prefix + suffix)) + suffix);
      process.disconnect();
    });`,
  );

  const outcome = await runFixtureProcess(request, entry, limits);

  expect(outcome).toMatchObject({ status: "not-found" });
  expect(JSON.stringify(outcome)).toHaveLength(1_024);
});

it("bounds analysis diagnostics even when no result is produced", async () => {
  const entry = await materializeProcessEntry(
    "diagnostics",
    `process.once("message", () => { process.stderr.write("x".repeat(2_000)); process.disconnect(); });`,
  );

  await expect(runFixtureProcess(request, entry, limits)).resolves.toEqual({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "analysis-output-bytes",
    message: "Inspection exceeded its analysis process output limit.",
  });
});

it("measures multibyte analysis diagnostics in bytes rather than characters", async () => {
  const entry = await materializeProcessEntry(
    "multibyte-diagnostics",
    `process.once("message", () => { process.stderr.write("€".repeat(400)); process.disconnect(); });`,
  );

  await expect(runFixtureProcess(request, entry, limits)).resolves.toEqual({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "analysis-output-bytes",
    message: "Inspection exceeded its analysis process output limit.",
  });
});

it("enforces the Node heap ceiling as an explicit memory limit", async () => {
  const entry = await materializeProcessEntry(
    "memory",
    `process.once("message", () => {
        const retained = [];
        while (true) retained.push({value: "x".repeat(1_024), index: retained.length});
      });`,
  );

  await expect(
    runFixtureProcess(request, entry, {
      ...limits,
      deadlineMilliseconds: 5_000,
      maxHeapMegabytes: 16,
      maxDiagnosticBytes: 64 * 1_024,
    }),
  ).resolves.toEqual({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "analysis-memory",
    message: "Inspection exceeded its analysis memory limit.",
  });
}, 10_000);

async function materializeProcessEntry(name: string, source: string): Promise<URL> {
  const path = join(fixtureRoot, `${name.replaceAll(" ", "-")}.mjs`);
  await writeFile(path, source);
  return pathToFileURL(path);
}

function runFixtureProcess(
  analysisRequest: AnalysisRequest,
  entry: URL,
  processLimits: typeof limits,
) {
  return Effect.runPromise(runAnalysisFixtureProcess(analysisRequest, entry, processLimits));
}
