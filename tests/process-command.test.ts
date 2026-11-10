import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { processExecutable } from "#typepeek/platform/process-executable";
import { processLayer } from "#typepeek/platform/process-runtime";

describe("Effect command execution", () => {
  it("preserves argument bytes without interpreting shell syntax", async () => {
    const argument = "path with spaces; $(echo unsafe) & 'quotes'";

    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      argument,
    ]);

    expect([result.exitCode, result.stdout, result.stderr]).toStrictEqual([
      0,
      argument,
      "",
    ]);
  });

  it("drains both output streams and preserves nonzero status", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        'process.stdout.write("out".repeat(100000)); process.stderr.write("err".repeat(100000)); process.exitCode=23;',
      ],
      { reject: false }
    );

    expect([
      result.failed,
      result.exitCode,
      result.stdout.length,
      result.stderr.length,
    ]).toStrictEqual([true, 23, 300_000, 300_000]);
  });

  it("reports unavailable optional commands without throwing", async () => {
    const result = await runCommand(
      nodePath.join(tmpdir(), "__typepeek_missing_executable__"),
      [],
      { reject: false }
    );

    expect([result.failed, result.exitCode, result.stdout]).toStrictEqual([
      true,
      null,
      "",
    ]);
  });

  it("retains final newlines when capturing a wire protocol", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", 'process.stdout.write("{}\\n")'],
      { trimFinalNewline: false }
    );

    expect(result.stdout).toBe("{}\n");
  });

  it("keeps concurrent noninteractive commands independent of terminal input", async () => {
    let attached = 0;

    const observe = (event: string | symbol) => {
      if (event === "end") {
        attached += 1;
      }
    };

    process.stdin.on("newListener", observe);

    try {
      await Promise.all(
        Array.from(
          { length: 12 },
          async () => await runCommand(process.execPath, ["--version"])
        )
      );
      expect(attached).toBe(0);
    } finally {
      process.stdin.off("newListener", observe);
    }
  });

  it("resolves Windows package-manager shims from PATH without a shell", async () => {
    const root = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-windows-command-")
    );

    const directory = nodePath.join(root, "path with spaces");

    const cli = nodePath.join(
      directory,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );

    await mkdir(nodePath.dirname(cli), { recursive: true });
    await writeFile(cli, "");
    await writeFile(nodePath.join(directory, "npm.cmd"), "");

    try {
      vi.stubEnv("PATH", directory);
      vi.stubGlobal("process", { ...process, platform: "win32" });
      await expect(
        Effect.runPromise(
          processExecutable("npm.cmd", ["pack", "path & spaces"]).pipe(
            Effect.provide(processLayer)
          )
        )
      ).resolves.toMatchObject({
        args: [cli, "pack", "path & spaces"],
        executable: process.execPath,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { extendEnv: true, redacted: false },
    { extendEnv: false, redacted: false },
    { extendEnv: true, redacted: true },
    { extendEnv: false, redacted: true },
  ])(
    "resolves Windows shims using child PATH and cwd with extendEnv=$extendEnv and redacted=$redacted",
    async ({ extendEnv, redacted }) => {
      const root = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-command-context-")
      );

      const inheritedDirectory = nodePath.join(root, "inherited");
      const cwd = nodePath.join(root, "child");
      const directory = nodePath.join(cwd, "bin");

      const cli = nodePath.join(
        directory,
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js"
      );

      await mkdir(inheritedDirectory, { recursive: true });
      await mkdir(nodePath.dirname(cli), { recursive: true });
      await writeFile(nodePath.join(inheritedDirectory, "npm.exe"), "");
      await writeFile(cli, "");
      await writeFile(nodePath.join(directory, "npm.cmd"), "");

      try {
        vi.stubEnv("PATH", inheritedDirectory);
        vi.stubGlobal("process", { ...process, platform: "win32" });

        const childPath = redacted ? Redacted.make("bin") : "bin";

        const resolved = await Effect.runPromise(
          processExecutable("npm", ["--version"], {
            cwd,
            env: { Path: childPath, TYPEPEEK_COMMAND_SENTINEL: "child" },
            extendEnv,
          }).pipe(Effect.provide(processLayer))
        );

        expect(resolved).toMatchObject({
          args: [cli, "--version"],
          env: { PATH: childPath, TYPEPEEK_COMMAND_SENTINEL: "child" },
          executable: process.execPath,
          extendEnv: false,
        });
        expect(resolved.env?.["PATH"]).toBe(childPath);
        expect(
          Object.keys(resolved.env ?? {}).filter(
            (key) => key.toLowerCase() === "path"
          )
        ).toStrictEqual(["PATH"]);
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(root, { force: true, recursive: true });
      }
    }
  );

  it("keeps a redacted Windows PATH out of shim-resolution failures", async () => {
    const root = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-redacted-command-")
    );

    await writeFile(nodePath.join(root, "npm.cmd"), "");

    try {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      await expect(
        Effect.runPromise(
          processExecutable("npm", [], {
            env: { PATH: Redacted.make(root) },
            extendEnv: false,
          }).pipe(Effect.provide(processLayer))
        )
      ).rejects.toThrow(
        "Cannot resolve the package-manager entrypoint for npm from <redacted>."
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not use inherited Windows PATH when command inheritance is disabled", async () => {
    const root = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-command-isolation-")
    );

    const inheritedDirectory = nodePath.join(root, "inherited");
    const cwd = nodePath.join(root, "child");
    await mkdir(inheritedDirectory);
    await mkdir(cwd);
    await writeFile(nodePath.join(inheritedDirectory, "npm.exe"), "");

    try {
      vi.stubEnv("PATH", inheritedDirectory);
      vi.stubGlobal("process", { ...process, platform: "win32" });
      await expect(
        Effect.runPromise(
          processExecutable("npm", ["--version"], {
            cwd,
            env: {},
            extendEnv: false,
          }).pipe(Effect.provide(processLayer))
        )
      ).resolves.toMatchObject({
        args: ["--version"],
        env: {},
        executable: "npm",
        extendEnv: false,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["pnpm.exe", true],
    ["pnpm.native.exe", true],
    ["pnpm.exe", false],
  ] as const)(
    "resolves a Windows pnpm shim backed by %s with extendEnv=%s and no replacement environment",
    async (filename, extendEnv) => {
      const root = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-windows-pnpm-")
      );

      const directory = nodePath.join(root, "path with spaces", "pnpm", "bin");
      const cli = nodePath.join(directory, filename);

      await mkdir(directory, { recursive: true });
      await writeFile(cli, "");
      await writeFile(nodePath.join(directory, "pnpm.cmd"), "");

      try {
        vi.stubEnv("PATH", directory);
        vi.stubGlobal("process", { ...process, platform: "win32" });
        await expect(
          Effect.runPromise(
            processExecutable("pnpm", ["--version", "path & spaces"], {
              extendEnv,
            }).pipe(Effect.provide(processLayer))
          )
        ).resolves.toMatchObject({
          args: ["--version", "path & spaces"],
          executable: cli,
        });
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(root, { force: true, recursive: true });
      }
    }
  );
});
