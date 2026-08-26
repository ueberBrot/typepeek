import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
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
const LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS = 5_000;

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

effectIt.live(
  "reaps the analysis process before caller Fiber interruption completes",
  () => {
    const readyPath = join(fixtureRoot, "interruption-ready");
    const terminationPath = join(fixtureRoot, "interruption-sigterm");

    return Effect.gen(function* () {
      const entry = yield* Effect.promise(() =>
        materializeProcessEntry(
          "caller-interruption",
          lifecycleFixtureSource(readyPath, terminationPath),
        ),
      );
      const fiber = yield* Effect.forkChild(
        runAnalysisFixtureProcess(request, entry, {
          ...limits,
          deadlineMilliseconds: 20_000,
        }),
      );
      const pid = yield* Effect.promise(() =>
        waitForProcessId(readyPath, LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS),
      );
      expect(processIsAlive(pid)).toBe(true);

      yield* Fiber.interrupt(fiber).pipe(Effect.timeout(LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS));
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);

      if (process.platform !== "win32") {
        yield* Effect.promise(() =>
          waitForFile(terminationPath, LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS),
        );
      }
      expect(processIsAlive(pid)).toBe(false);
    }).pipe(Effect.ensuring(Effect.promise(() => forceTerminateProcessFromReadyFile(readyPath))));
  },
  10_000,
);

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

it("maps an analysis process launch failure to the deterministic terminated outcome", async () => {
  await expect(
    runFixtureProcess(request, new URL("https://invalid.typepeek.test/analysis.mjs"), limits),
  ).resolves.toEqual({
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

function lifecycleFixtureSource(readyPath: string, terminationPath: string): string {
  const terminationHandler =
    process.platform === "win32"
      ? ""
      : `process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(terminationPath)}, "SIGTERM");
  setInterval(() => {}, 1_000);
});`;

  return `import { writeFileSync } from "node:fs";
${terminationHandler}
writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
process.once("message", () => setInterval(() => {}, 1_000));`;
}

async function waitForProcessId(path: string, timeoutMilliseconds: number): Promise<number> {
  const serialized = await waitForFile(path, timeoutMilliseconds);
  return parseProcessId(serialized);
}

function parseProcessId(serialized: string): number {
  const pid = Number(serialized);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Analysis fixture wrote invalid process ID ${JSON.stringify(serialized)}.`);
  }
  return pid;
}

async function waitForFile(path: string, timeoutMilliseconds: number): Promise<string> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for analysis fixture file ${path}.`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function forceTerminateProcessFromReadyFile(readyPath: string): Promise<void> {
  const pid = await readProcessIdIfPresent(readyPath);
  if (pid === undefined || !processIsAlive(pid)) return;

  forceKillProcess(pid);
  await waitForProcessExit(pid);
}

async function readProcessIdIfPresent(path: string): Promise<number | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch {
    return;
  }
  return parseProcessId(serialized);
}

function forceKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = performance.now() + LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS;
  while (processIsAlive(pid) && performance.now() < deadline) {
    await delay(10);
  }
  if (processIsAlive(pid)) {
    throw new Error(`Could not reap analysis fixture process ${pid}.`);
  }
}

function runFixtureProcess(
  analysisRequest: AnalysisRequest,
  entry: URL,
  processLimits: typeof limits,
) {
  return Effect.runPromise(runAnalysisFixtureProcess(analysisRequest, entry, processLimits));
}
