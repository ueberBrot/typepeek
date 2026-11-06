import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { performance } from "node:perf_hooks";
import { setInterval as interval } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { live as it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { afterAll, beforeAll, describe, expect } from "vite-plus/test";

import { runAnalysisFixtureProcess } from "#typepeek/inspection/analysis-process";
import type { AnalysisRequest } from "#typepeek/inspection/protocol";

import { match } from "./helpers/matchers.ts";

const request: AnalysisRequest = {
  intent: "interface-overview",
  request: {
    accessStyle: "import",
    resolutionContext: "/fixture",
    specifier: "fixture",
  },
};

const limits = {
  // Leave process startup headroom when the full suite saturates CI workers.
  deadlineMilliseconds: 2000,
  maxDiagnosticBytes: 1024,
  maxHeapMegabytes: 32,
  maxResultBytes: 1024,
};

const timeoutLimits = { ...limits, deadlineMilliseconds: 500 };
const LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS = 5000;
let fixtureRoot: string;

const materializeProcessEntry = async function materializeProcessEntry(
  name: string,
  source: string
): Promise<URL> {
  const path = nodePath.join(fixtureRoot, `${name.replaceAll(" ", "-")}.mjs`);
  await writeFile(path, source);

  return pathToFileURL(path);
};

const lifecycleFixtureSource = function lifecycleFixtureSource(
  readyPath: string,
  terminationPath: string
): string {
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
process.stdin.once("data", () => setInterval(() => {}, 1_000));`;
};

const waitForFile = async function waitForFile(
  path: string,
  timeoutMilliseconds: number
): Promise<string> {
  const deadline = performance.now() + timeoutMilliseconds;

  for await (const expiration of interval(10, deadline)) {
    if (performance.now() >= expiration) {
      break;
    }

    try {
      return await readFile(path, "utf-8");
    } catch {
      // The worker has not created its readiness file yet.
    }
  }

  throw new Error(`Timed out waiting for analysis fixture file ${path}.`);
};

const parseProcessId = function parseProcessId(serialized: string): number {
  const pid = Number(serialized);

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(
      `Analysis fixture wrote invalid process ID ${JSON.stringify(serialized)}.`
    );
  }

  return pid;
};

const waitForProcessId = async function waitForProcessId(
  path: string,
  timeoutMilliseconds: number
): Promise<number> {
  const serialized = await waitForFile(path, timeoutMilliseconds);

  return parseProcessId(serialized);
};

const processIsAlive = function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      throw error;
    }

    const { code } = error;

    if (code === "ESRCH") {
      return false;
    }

    if (code === "EPERM") {
      return true;
    }

    throw error;
  }
};

const readProcessIdIfPresent = async function readProcessIdIfPresent(
  path: string
): Promise<number | undefined> {
  let serialized: string;

  try {
    serialized = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }

  return parseProcessId(serialized);
};

const forceKillProcess = function forceKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }

    throw error;
  }
};

const waitForProcessExit = async function waitForProcessExit(
  pid: number
): Promise<void> {
  const deadline = performance.now() + LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS;

  for await (const expiration of interval(10, deadline)) {
    if (!processIsAlive(pid) || performance.now() >= expiration) {
      break;
    }
  }

  if (processIsAlive(pid)) {
    throw new Error(`Could not reap analysis fixture process ${pid}.`);
  }
};

const forceTerminateProcessFromReadyFile =
  async function forceTerminateProcessFromReadyFile(
    readyPath: string
  ): Promise<void> {
    const pid = await readProcessIdIfPresent(readyPath);

    if (pid === undefined || !processIsAlive(pid)) {
      return;
    }

    forceKillProcess(pid);
    await waitForProcessExit(pid);
  };

const verifyEffectScenario = function* verifyEffectScenario() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "success",
        `process.stdin.once("data", () => {
            process.stdout.write(JSON.stringify({status:"not-found", reason:"specifier-not-found", message:"bounded absence"}));

          });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    message: "bounded absence",
    reason: "specifier-not-found",
    status: "not-found",
  });
};

const verifyEffectScenario2 = function* verifyEffectScenario2(
  name: string,
  source: string
) {
  const entry = yield* Effect.promise(
    async () => await materializeProcessEntry(name, source)
  );

  const outcome = yield* runAnalysisFixtureProcess(
    request,
    entry,
    timeoutLimits
  );

  expect(outcome).toStrictEqual({
    exceededBudget: "analysis-deadline",
    message: "Inspection exceeded its analysis deadline.",
    reason: "budget-exceeded",
    status: "limit-exceeded",
  });
};

const verifyEffectScenario3 = function* verifyEffectScenario3() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "terminated",
        `process.stdin.once("data", () => process.exit(23));`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    message: "Inspection analysis terminated before completion.",
    reason: "analysis-terminated",
    status: "unsupported",
  });
};

const verifyEffectScenario4 = function* verifyEffectScenario4() {
  const outcome = yield* runAnalysisFixtureProcess(
    request,
    new URL("https://invalid.typepeek.test/analysis.mjs"),
    limits
  );

  expect(outcome).toStrictEqual({
    message: "Inspection analysis terminated before completion.",
    reason: "analysis-terminated",
    status: "unsupported",
  });
};

const verifyEffectScenario5 = function* verifyEffectScenario5(
  name: string,
  source: string
) {
  const entry = yield* Effect.promise(
    async () => await materializeProcessEntry(name, source)
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    message: "Inspection could not validate the analysis process result.",
    reason: "invalid-result",
    status: "unsupported",
  });
};

const verifyEffectScenario6 = function* verifyEffectScenario6() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "duplicate",
        `process.stdin.once("data", () => {
      process.stdout.write(JSON.stringify({status:"not-found", message:"first"}));
      process.stdout.write(JSON.stringify({status:"not-found", message:"second"}));

    });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    message: "Inspection could not validate the analysis process result.",
    reason: "invalid-result",
    status: "unsupported",
  });
};

const verifyEffectScenario7 = function* verifyEffectScenario7() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "oversized",
        `process.stdin.once("data", () => {
      process.stdout.write(JSON.stringify({status:"not-found", message:"x".repeat(2_000)}));

    });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    exceededBudget: "analysis-output-bytes",
    message: "Inspection exceeded its analysis process output limit.",
    reason: "budget-exceeded",
    status: "limit-exceeded",
  });
};

const verifyEffectScenario8 = function* verifyEffectScenario8() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "exact-output-boundary",
        `process.stdin.once("data", () => {
      const prefix = '{"status":"not-found","reason":"specifier-not-found","message":"';
      const suffix = '"}';
      process.stdout.write(prefix + "x".repeat(1024 - Buffer.byteLength(prefix + suffix)) + suffix);

    });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect([outcome, JSON.stringify(outcome).length]).toStrictEqual([
    match.objectContaining({ status: "not-found" }),
    1024,
  ]);
};

const verifyEffectScenario9 = function* verifyEffectScenario9() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "diagnostics",
        `process.stdin.once("data", () => { process.stderr.write("x".repeat(2_000));  });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    exceededBudget: "analysis-output-bytes",
    message: "Inspection exceeded its analysis process output limit.",
    reason: "budget-exceeded",
    status: "limit-exceeded",
  });
};

const verifyEffectScenario10 = function* verifyEffectScenario10() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "multibyte-diagnostics",
        `process.stdin.once("data", () => { process.stderr.write("€".repeat(400));  });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, limits);
  expect(outcome).toStrictEqual({
    exceededBudget: "analysis-output-bytes",
    message: "Inspection exceeded its analysis process output limit.",
    reason: "budget-exceeded",
    status: "limit-exceeded",
  });
};

const verifyEffectScenario11 = function* verifyEffectScenario11() {
  const entry = yield* Effect.promise(
    async () =>
      await materializeProcessEntry(
        "memory",
        `process.stdin.once("data", () => {
        const retained = [];
        while (true) retained.push({value: "x".repeat(1_024), index: retained.length});
      });`
      )
  );

  const outcome = yield* runAnalysisFixtureProcess(request, entry, {
    ...limits,
    deadlineMilliseconds: 5000,
    maxDiagnosticBytes: 64 * 1024,
    maxHeapMegabytes: 16,
  });

  expect(outcome).toStrictEqual({
    exceededBudget: "analysis-memory",
    message: "Inspection exceeded its analysis memory limit.",
    reason: "budget-exceeded",
    status: "limit-exceeded",
  });
};

describe("analysis-process", () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-analysis-process-")
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  it.each([512 * 1024, 2 * 1024 * 1024])(
    "drains and bounds the separate cache channel at %i bytes",
    (bytes) => {
      const cacheChannelBudget = function* cacheChannelBudget() {
        const entry = yield* Effect.promise(
          async () =>
            await materializeProcessEntry(
              `cache-channel-${bytes}`,
              `
      import {createWriteStream} from "node:fs";
      process.stdin.resume();
      process.stdin.once("end", () => {
        const metadata = createWriteStream("", {fd: 3});
        metadata.end(JSON.stringify("x".repeat(${bytes})), () => {
          process.stdout.write(JSON.stringify({status:"not-found", reason:"specifier-not-found", message:"bounded absence"}));
        });
      });
    `
            )
        );

        const outcome = yield* runAnalysisFixtureProcess(
          request,
          entry,
          limits
        );

        expect(outcome).toMatchObject(
          bytes > 1024 * 1024
            ? {
                exceededBudget: "analysis-output-bytes",
                status: "limit-exceeded",
              }
            : { reason: "specifier-not-found", status: "not-found" }
        );
      };

      return Effect.gen(cacheChannelBudget);
    }
  );

  it("accepts exactly one bounded result from a cleanly exited analysis process", () =>
    Effect.gen(verifyEffectScenario));
  it("reaps the analysis process before caller Fiber interruption completes", () => {
    const readyPath = nodePath.join(fixtureRoot, "interruption-ready");
    const terminationPath = nodePath.join(fixtureRoot, "interruption-sigterm");

    const verifyEffect2 = function* verifyEffect2() {
      const entry = yield* Effect.promise(
        async () =>
          await materializeProcessEntry(
            "caller-interruption",
            lifecycleFixtureSource(readyPath, terminationPath)
          )
      );

      const fiber = yield* Effect.forkChild(
        runAnalysisFixtureProcess(request, entry, {
          ...limits,
          deadlineMilliseconds: 20_000,
        })
      );

      const pid = yield* Effect.promise(
        async () =>
          await waitForProcessId(
            readyPath,
            LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS
          )
      );

      expect(processIsAlive(pid)).toBeTruthy();
      yield* Fiber.interrupt(fiber).pipe(
        Effect.timeout(LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS)
      );
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBeTruthy();

      if (process.platform !== "win32") {
        yield* Effect.promise(
          async () =>
            await waitForFile(
              terminationPath,
              LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS
            )
        );
      }

      expect(processIsAlive(pid)).toBeFalsy();
    };

    return Effect.gen(verifyEffect2).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await forceTerminateProcessFromReadyFile(readyPath);
        })
      )
    );
  }, 10_000);

  it.each(["deadline", "interruption"] as const)(
    "reaps native descendants after %s",
    (reason) => {
      const readyPath = nodePath.join(fixtureRoot, `native-${reason}-ready`);

      const verifyDescendant = function* verifyDescendant() {
        const entry = yield* Effect.promise(
          async () =>
            await materializeProcessEntry(
              `native-${reason}`,
              `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["--eval", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: ["ignore", "ignore", "inherit"] });
writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));
process.stdin.once("data", () => setInterval(() => {}, 1000));`
            )
        );

        const fiber = yield* Effect.forkChild(
          runAnalysisFixtureProcess(request, entry, {
            ...limits,
            deadlineMilliseconds: reason === "deadline" ? 1000 : 20_000,
          })
        );

        const pid = yield* Effect.promise(
          async () =>
            await waitForProcessId(
              readyPath,
              LIFECYCLE_ASSERTION_TIMEOUT_MILLISECONDS
            )
        );

        if (reason === "interruption") {
          yield* Fiber.interrupt(fiber);
        } else {
          const outcome = yield* Fiber.join(fiber);
          expect(outcome).toMatchObject({
            exceededBudget: "analysis-deadline",
            status: "limit-exceeded",
          });
        }

        yield* Effect.promise(async () => {
          await waitForProcessExit(pid);
        });
        expect(processIsAlive(pid)).toBeFalsy();
      };

      return Effect.gen(verifyDescendant).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await forceTerminateProcessFromReadyFile(readyPath);
          })
        )
      );
    },
    10_000
  );

  it.each([
    {
      name: "never responds",
      source: `process.stdin.once("data", () => setInterval(() => {}, 1_000));`,
    },
    {
      name: "sends a plausible result but never exits",
      source: `process.stdin.once("data", () => {
      process.stdout.write(JSON.stringify({status:"not-found", message:"partial"}));
      setInterval(() => {}, 1_000);
    });`,
    },
  ])("kills an analysis process that $name", ({ name, source }) =>
    Effect.gen(verifyEffectScenario2.bind(undefined, name, source))
  );

  it("rejects a terminated analysis process without an authoritative result", () =>
    Effect.gen(verifyEffectScenario3));

  it("maps an analysis process launch failure to the deterministic terminated outcome", () =>
    Effect.gen(verifyEffectScenario4));

  it.each([
    {
      name: "no result",
      source: `process.stdin.once("data", () => {});`,
    },
    {
      name: "malformed result",
      source: `process.stdin.once("data", () => { process.stdout.write("{not-json");  });`,
    },
  ])("rejects a clean exit with $name", ({ name, source }) =>
    Effect.gen(verifyEffectScenario5.bind(undefined, name, source))
  );

  it("rejects multiple analysis results instead of choosing a partial result", () =>
    Effect.gen(verifyEffectScenario6));

  it("rejects analysis transport output beyond its measured budget", () =>
    Effect.gen(verifyEffectScenario7));

  it("accepts a valid result exactly at the transport byte boundary", () =>
    Effect.gen(verifyEffectScenario8));

  it("bounds analysis diagnostics even when no result is produced", () =>
    Effect.gen(verifyEffectScenario9));

  it("measures multibyte analysis diagnostics in bytes rather than characters", () =>
    Effect.gen(verifyEffectScenario10));

  it(
    "enforces the Node heap ceiling as an explicit memory limit",
    () => Effect.gen(verifyEffectScenario11),
    10_000
  );
});
