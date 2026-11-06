import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { runCommand } from "#typepeek/process-command";
import { processExecutable } from "#typepeek/process-executable";

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
      expect(
        processExecutable("npm.cmd", ["pack", "path & spaces"])
      ).toStrictEqual({
        args: [cli, "pack", "path & spaces"],
        executable: process.execPath,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["pnpm.exe", "pnpm.native.exe"])(
    "resolves a Windows pnpm shim backed by %s",
    async (filename) => {
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
        expect(
          processExecutable("pnpm", ["--version", "path & spaces"])
        ).toStrictEqual({
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
