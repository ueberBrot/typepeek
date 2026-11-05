import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vite-plus/test";

import { materializeStaticInspection } from "./helpers/static-inspection.ts";

const channelUrl = new URL(
  "../syncChannel.js",
  import.meta.resolve("tsrs/sync")
).href;

describe("Static Inspection compiler launch tripwire", () => {
  it.each([
    ["accepts the pinned SDK Windows pipe transport", "native", 0],
    ["rejects another pipe namespace", "other-pipe", 1],
    ["rejects extra compiler arguments", "extra-argument", 1],
    ["rejects an unexpected callback set", "other-callbacks", 1],
  ] as const)("%s", async (_description, variant, expectedExitCode) => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-compiler-tripwire-")
    );

    try {
      await materializeStaticInspection(fixtureRoot);
      const probe = nodePath.join(fixtureRoot, "compiler-launch.mjs");
      const sentinel = nodePath.join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
      const preload = nodePath.join(fixtureRoot, "inspection-tripwire.cjs");

      await writeFile(
        probe,
        [
          'import { spawn } from "node:child_process";',
          `import { createPipePath } from ${JSON.stringify(channelUrl)};`,
          'Object.defineProperty(process, "platform", { value: "win32" });',
          `const variant = ${JSON.stringify(variant)};`,
          "const args = [",
          "  '--api', '--cwd', process.cwd(), '--useCaseSensitiveFileNames=false',",
          "  '--callbacks=directoryExists,fileExists,getAccessibleEntries,readFile,realpath,removeFile,stat,writeFile',",
          "  '--pipe', createPipePath(),",
          "];",
          "if (variant === 'other-pipe') args[6] = args[6].replace('tsgo-sync-', 'other-');",
          "if (variant === 'extra-argument') args.push('--locale=en');",
          "if (variant === 'other-callbacks') args[4] = '--callbacks=readFile';",
          // Node rejects --api before executing code; reaching that exit proves the guard allowed spawning.
          "const child = spawn(process.execPath, args, { stdio: 'ignore' });",
          "await new Promise((resolve, reject) => {",
          "  child.once('error', reject);",
          "  child.once('exit', (code) => code === 9 ? resolve() : reject(new Error('Unexpected compiler probe exit: ' + code)));",
          "});",
          "process.stdout.write('compiler launch accepted');",
        ].join("\n")
      );

      const result = await execa(process.execPath, [probe], {
        cwd: fixtureRoot,
        env: {
          NODE_OPTIONS: [
            `--require=${JSON.stringify(preload)}`,
            "--permission",
            "--allow-fs-read=*",
            `--allow-fs-write=${JSON.stringify(sentinel)}`,
            "--allow-child-process",
            "--allow-worker",
          ].join(" "),
          TYPEPEEK_ALLOWED_ANALYSIS_PROCESS_ENTRY: probe,
          TYPEPEEK_ALLOWED_COMPILER_EXECUTABLE: process.execPath,
          TYPEPEEK_DENY_WORKERS: "true",
          TYPEPEEK_IO_SENTINEL: sentinel,
        },
        reject: false,
      });

      const activity = existsSync(sentinel)
        ? await readFile(sentinel, "utf-8")
        : undefined;

      expect([result.exitCode, result.stdout, activity]).toStrictEqual([
        expectedExitCode,
        expectedExitCode === 0 ? "compiler launch accepted" : "",
        expectedExitCode === 0 ? undefined : "process activity",
      ]);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
