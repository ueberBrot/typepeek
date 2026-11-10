import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { defineSandbox, defineWorkspace } from "@tanstack/ai-sandbox";
import { describe, expect, it, vi } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";

import { createCodexTrial } from "../benchmarks/codex-discovery/fixture.ts";
import {
  createHarnessArtifacts,
  serializeHarnessArtifact,
} from "../benchmarks/harness/artifacts.ts";
import { cleanupSandboxRun } from "../benchmarks/harness/cleanup.ts";
import {
  codexSandbox,
  codexSandboxCreateArguments,
} from "../benchmarks/harness/codex-sandbox.ts";
import { MIN_SBX_VERSION } from "../benchmarks/harness/sbx-version.ts";
import { createTestHarness } from "../benchmarks/harness/session.ts";
import { harnessCommand, shellArgument } from "../benchmarks/harness/tasks.ts";
import { createSandboxCliFixture } from "./helpers/sandbox-fixture.ts";

describe("sandbox harness", () => {
  it.each(["v0.50.1", "unrecognized"])(
    "rejects unsupported Docker versions before connecting or creating resources: %s",
    async (version) => {
      const fixture = await createSandboxCliFixture();

      try {
        await writeFile(nodePath.join(fixture.root, "version"), version);

        const result = await runCommand(
          process.execPath,
          ["benchmarks/harness/run.ts", "--check"],
          {
            env: {
              PATH: `${fixture.root}${nodePath.delimiter}${process.env["PATH"] ?? ""}`,
            },
            reject: false,
          }
        );

        expect(result.failed).toBeTruthy();
        expect(result.stderr).toContain(`${MIN_SBX_VERSION} or newer`);
        await expect(
          readFile(nodePath.join(fixture.root, "commands.jsonl"), "utf-8")
        ).resolves.toBe('["version"]\n');
      } finally {
        await fixture.close();
      }
    }
  );

  it("checks the Docker connection without creating a sandbox or requesting inference", async () => {
    const fixture = await createSandboxCliFixture();

    try {
      const result = await runCommand(
        process.execPath,
        ["benchmarks/harness/run.ts", "--check"],
        {
          env: {
            PATH: `${fixture.root}${nodePath.delimiter}${process.env["PATH"] ?? ""}`,
          },
        }
      );

      expect(result.stdout).toContain("Docker sandbox connection verified");
      await expect(
        readFile(nodePath.join(fixture.root, "commands.jsonl"), "utf-8")
      ).resolves.toBe('["version"]\n["ls","--json"]\n');
      await expect(
        readdir(nodePath.join(fixture.root, "guests"))
      ).resolves.toStrictEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps rebased scratch writable while denying the operating-system temp directory", async () => {
    const fixture = await createSandboxCliFixture();
    const modules = nodePath.join(fixture.root, "consumer", "node_modules");
    await mkdir(modules, { recursive: true });

    try {
      const trial = await createCodexTrial(
        {
          cleanup: fixture.close,
          codexExecutable: process.execPath,
          codexHome: nodePath.join(fixture.root, "codex"),
          manifest: "{}",
          modules,
          root: fixture.root,
          toolBin: nodePath.join(fixture.root, "tools", "bin"),
          toolRoot: nodePath.join(fixture.root, "tools", "typepeek"),
        },
        "temp-profile",
        "files"
      );

      const filesystem = trial.configArguments.find((argument) =>
        argument.startsWith("permissions.discovery.filesystem=")
      );

      expect([
        filesystem?.includes('":tmpdir"'),
        filesystem?.includes(`${JSON.stringify(tmpdir())} = "deny"`),
      ]).toStrictEqual([false, true]);
    } finally {
      await fixture.close();
    }
  });

  it.each(["/source with spaces", "D:\\Projects\\source with spaces"])(
    "provisions Docker's Codex agent using the host workspace path: %s",
    (workspace) => {
      expect(
        codexSandboxCreateArguments("typepeek-test", {
          workspace,
        })
      ).toStrictEqual([
        "--no-input",
        "create",
        "--name",
        "typepeek-test",
        "--no-progress",
        "--skills",
        "off",
        "--static-mcp",
        "none",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--clone",
        "codex",
        workspace,
      ]);
      expect(() => codexSandboxCreateArguments("../other", {})).toThrow(
        "Invalid Docker sandbox name"
      );
    }
  );

  it("quotes task arguments and retains the benchmark artifact location", () => {
    expect(
      harnessCommand("test", ["tests/name with 'quotes'.test.ts"])
    ).toContain(shellArgument("tests/name with 'quotes'.test.ts"));
    expect(() => harnessCommand("benchmark", ["--output=elsewhere"])).toThrow(
      "preserve benchmark artifacts"
    );
    expect(() => harnessCommand("unknown", [])).toThrow("Unknown sandbox task");
  });

  it("redacts credential fields while retaining usage counts", () => {
    const artifact = serializeHarnessArtifact({
      access_token: "private",
      nested: { authorization: "Bearer private", inputTokens: 42 },
    });

    expect(artifact).toBe(
      '{"access_token":"<REDACTED>","nested":{"authorization":"<REDACTED>","inputTokens":42}}'
    );
  });

  it("cleans up a sandbox when creation fails after allocation", async () => {
    const fixture = await createSandboxCliFixture();
    const provider = codexSandbox({ binary: fixture.binary });

    try {
      await writeFile(fixture.failCreate, "");
      await expect(provider.create({ id: "partial-creation" })).rejects.toThrow(
        "failed after allocating"
      );
      await expect(
        readdir(nodePath.join(fixture.root, "guests"))
      ).resolves.toStrictEqual([]);
    } finally {
      await provider.close();
      await fixture.close();
    }
  });

  it("waits for in-flight creation before completing cleanup", async () => {
    const fixture = await createSandboxCliFixture();
    const provider = codexSandbox({ binary: fixture.binary });
    const pause = nodePath.join(fixture.root, "pause-create");
    await writeFile(pause, "");
    const creation = provider.create({ id: "interrupted-creation" });

    try {
      await vi.waitFor(() => {
        expect(
          existsSync(nodePath.join(fixture.root, "create-started"))
        ).toBeTruthy();
      });
      const closing = provider.close();
      await rm(pause);
      await expect(creation).rejects.toThrow("already closed");
      await closing;
      await expect(
        readdir(nodePath.join(fixture.root, "guests"))
      ).resolves.toStrictEqual([]);
    } finally {
      await rm(pause, { force: true });
      await provider.close();
      await fixture.close();
    }
  });

  it("records failed cleanup and retries only the run's owned resources", async () => {
    const fixture = await createSandboxCliFixture();
    const output = nodePath.join(fixture.root, "artifacts");
    const artifacts = createHarnessArtifacts(output);

    const provider = codexSandbox({
      binary: fixture.binary,
      onResource: (event) => {
        artifacts.record("resources.jsonl", { ...event });
      },
    });

    try {
      await provider.create({ id: "cleanup-retry" });
      await writeFile(fixture.failRemove, "");
      await expect(provider.close()).rejects.toThrow("cleanup failed");
      await expect(
        readFile(nodePath.join(output, "resources.jsonl"), "utf-8")
      ).resolves.toContain("cleanup-failed");
      await rm(fixture.failRemove);
      await expect(
        cleanupSandboxRun(output, fixture.binary)
      ).resolves.toStrictEqual({ removed: 1 });
      await expect(
        readdir(nodePath.join(fixture.root, "guests"))
      ).resolves.toStrictEqual([]);
    } finally {
      await rm(fixture.failRemove, { force: true });
      await provider.close();
      await fixture.close();
    }
  });

  it("rejects a foreign sandbox name before running cleanup", async () => {
    const fixture = await createSandboxCliFixture();
    const output = nodePath.join(fixture.root, "artifacts");
    const artifacts = createHarnessArtifacts(output);
    artifacts.record("resources.jsonl", {
      id: "personal-sandbox",
      state: "ready",
    });

    try {
      await expect(cleanupSandboxRun(output, fixture.binary)).rejects.toThrow(
        /typepeek/u
      );
      await expect(readdir(fixture.root)).resolves.not.toContain(
        "commands.jsonl"
      );
    } finally {
      await fixture.close();
    }
  });

  it.each(["command", "codex"] as const)(
    "executes the %s agent through TanStack, exports logs and traces, and removes the sandbox",
    async (agent) => {
      const fixture = await createSandboxCliFixture();
      const { binary, root } = fixture;
      const provider = codexSandbox({ binary });
      const output = nodePath.join(root, "artifacts");

      const harness = createTestHarness({
        artifacts: createHarnessArtifacts(output),
        runId: "fixture-run",
        sandbox: defineSandbox({
          fileEvents: false,
          id: "fixture",
          provider,
          workspace: defineWorkspace({ source: { type: "none" } }),
        }),
      });

      try {
        const session = await harness.open();

        const result =
          agent === "command"
            ? await session.agents.command.run({
                command:
                  "printf 'fixture stdout'; printf 'fixture stderr' >&2; exit 7",
              })
            : await session.agents.codex.run({
                model: "gpt-6.1-sol",
                prompt: "Reply with TYPEPEEK_SANDBOX_READY",
              });

        expect("exitCode" in result ? result.exitCode : result.answer).toBe(
          agent === "command" ? 7 : "TYPEPEEK_SANDBOX_READY"
        );
        await session.close();
        await provider.close();
        await harness.close();
        const files = await readdir(output);

        const artifacts = await Promise.all(
          files.map(
            async (file) => await readFile(nodePath.join(output, file), "utf-8")
          )
        );

        const combined = artifacts.join("\n");
        expect([
          files.includes("harness.log.jsonl"),
          files.includes("events.jsonl"),
          files.includes("traces.jsonl"),
          combined.includes(
            agent === "command"
              ? "fixture stderr"
              : "provider=codex type=turn.completed"
          ),
          combined.includes('"phase":"settled"'),
          combined.includes("harness.operation"),
          await readdir(nodePath.join(root, "guests")),
        ]).toStrictEqual([true, true, true, true, true, true, []]);
      } finally {
        await provider.close();
        await harness.close();

        await fixture.close();
      }
    }
  );
});
