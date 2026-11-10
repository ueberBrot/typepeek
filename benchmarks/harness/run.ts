import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { parseArgs } from "node:util";

import { defineSandbox, defineWorkspace } from "@tanstack/ai-sandbox";

import { runCommand } from "#typepeek/platform/process-command";

import { prepareOutputDirectory } from "../support/output-directory.ts";
import { createHarnessArtifacts } from "./artifacts.ts";
import { cleanupSandboxRun } from "./cleanup.ts";
import { codexSandbox } from "./codex-sandbox.ts";
import { MIN_SBX_VERSION, requireSupportedSbxVersion } from "./sbx-version.ts";
import { createTestHarness } from "./session.ts";
import { stageHarnessSource } from "./source.ts";
import { HARNESS_SETUP, harnessCommand } from "./tasks.ts";

const SMOKE_REPLY = "TYPEPEEK_SANDBOX_READY";

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: vp run sandbox [options] -- TASK [task arguments]

Tasks: test, quality, benchmark-smoke, benchmark, agent-smoke
  --check                  Verify the Docker connection without creating a sandbox
  --cleanup DIRECTORY      Remove sandboxes recorded by an interrupted run
  --output DIRECTORY       Empty directory for logs, traces, and results
  --timeout-seconds N      Bound setup and execution (default: 600)
  --model NAME             Codex model for agent-smoke

Requires Docker Sandboxes ${MIN_SBX_VERSION} or newer, sbx login, Docker-managed Codex OAuth, and initialized Docker network policy.
Runs use a private clone of tracked working-tree files. Stage new source files first.
Benchmark arguments follow -- benchmark; provisioning is outside measurement.
Live benchmark and agent-smoke tasks consume subscription usage.
`);
  process.exit(0);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    check: { default: false, type: "boolean" },
    cleanup: { type: "string" },
    model: { default: "gpt-6.1-sol", type: "string" },
    output: {
      default: `.benchmarks/sandbox/${new Date().toISOString().replaceAll(":", "-")}`,
      type: "string",
    },
    "timeout-seconds": { default: "600", type: "string" },
  },
});

const version = await runCommand("sbx", ["version"]);

if (values.cleanup === undefined) {
  requireSupportedSbxVersion(version.stdout);
}

const readiness = await runCommand("sbx", ["--no-input", "ls", "--json"], {
  reject: false,
});

if (readiness.failed) {
  throw new Error(
    `Docker Sandboxes is unavailable: ${readiness.stderr.trim()}`
  );
}

if (values.cleanup !== undefined) {
  const result = await cleanupSandboxRun(nodePath.resolve(values.cleanup));
  process.stdout.write(`Removed ${result.removed} recorded sandbox(es).\n`);
} else if (values.check) {
  process.stdout.write(
    `${version.stdout}\nDocker sandbox connection verified. No sandbox or model was started.\n`
  );
} else {
  const task = positionals[0] ?? "test";
  const cliArguments = positionals.slice(1);
  const timeout = Number(values["timeout-seconds"]) * 1000;

  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > 86_400_000
  ) {
    throw new Error("Use a timeout between 1 and 86400 seconds.");
  }

  const agentSmoke = task === "agent-smoke";

  const command = agentSmoke
    ? undefined
    : `export PATH="$HOME/.local/typepeek-node/bin:$PATH"; ${harnessCommand(task, cliArguments)}`;

  const output = nodePath.resolve(values.output);
  await prepareOutputDirectory(output, "sandbox");

  const staged = await stageHarnessSource(process.cwd());
  const artifacts = createHarnessArtifacts(output);

  const provider = codexSandbox({
    onCommand: (event) => {
      artifacts.record("setup.jsonl", { ...event });
      artifacts.verify();
    },
    onResource: (event) => {
      artifacts.record("resources.jsonl", { ...event });
      artifacts.verify();
    },
    setupNetwork: !agentSmoke,
    workspace: staged.directory,
  });

  const runId = `typepeek-${randomUUID()}`;

  const sandbox = defineSandbox({
    fileEvents: { diff: true },
    id: "typepeek-test-suite",
    lifecycle: { destroyOnComplete: false, reuse: "none", snapshot: "none" },
    provider,
    workspace: defineWorkspace({
      setup: agentSmoke ? [] : HARNESS_SETUP,
      source: { path: staged.directory, type: "local" },
    }),
  });

  const harness = createTestHarness({ artifacts, runId, sandbox });
  harness.artifacts.record("manifest.jsonl", {
    runId,
    sbx: version.stdout,
    sourceHash: staged.hash,
    task,
  });

  try {
    const session = await harness.open();

    const operation =
      command === undefined
        ? session.agents.codex.run({
            model: values.model,
            prompt: `Reply with exactly ${SMOKE_REPLY}. Do not use tools.`,
          })
        : session.agents.command.run({ command });

    const cancel = async (): Promise<void> => {
      const outcomes = await Promise.allSettled([
        operation.cancel("Sandbox run interrupted or exceeded its deadline."),
        provider.close(),
      ]);

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          harness.artifacts.logger.error("Cancellation cleanup failed", {
            message: String(outcome.reason),
          });
        }
      }
    };

    const onInterrupt = (): void => {
      void cancel();
    };

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    const timer = setTimeout(() => {
      void cancel();
    }, timeout);

    try {
      const result = await operation;
      harness.artifacts.record("result.jsonl", { ...result });

      if (
        agentSmoke &&
        (!("answer" in result) || result.answer !== SMOKE_REPLY)
      ) {
        throw new Error("The sandboxed Codex smoke reply did not match.");
      }

      if (
        command !== undefined &&
        "exitCode" in result &&
        result.exitCode !== 0
      ) {
        process.exitCode = 1;
      }

      if (
        task === "benchmark" &&
        !cliArguments.includes("--prepare-only") &&
        !cliArguments.includes("--dry-run")
      ) {
        const handle = await sandbox.ensure({ runId, threadId: runId });
        const archive = ".benchmarks/sandbox-results.tar.gz";

        const packed = await handle.process.exec(
          `tar -czf ${archive} -C .benchmarks sandbox-results`
        );

        if (packed.exitCode !== 0) {
          throw new Error("Benchmark artifacts could not be archived.");
        }

        await writeFile(
          nodePath.join(output, "benchmark-results.tar.gz"),
          await handle.fs.readBytes(archive),
          { mode: 0o600 }
        );
      }
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      await session.close();
    }
  } finally {
    try {
      await provider.close();
    } finally {
      try {
        await harness.close();
      } finally {
        await staged.cleanup();
      }
    }
  }
}
