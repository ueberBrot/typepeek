import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vite-plus/test";

import { COMPILER_EXECUTABLE } from "#typepeek/inspection/compiler-distribution";

import {
  materializeStaticInspection,
  staticInspectionNodeOptions,
} from "./helpers/static-inspection.ts";

const channelUrl = new URL(
  "../syncChannel.js",
  import.meta.resolve("tsrs/sync")
).href;

describe("Static Inspection compiler launch tripwire", () => {
  it("connects to the pinned native compiler under the guard", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-compiler-connection-")
    );

    try {
      const inspection = await materializeStaticInspection(fixtureRoot);
      const preload = nodePath.join(fixtureRoot, "inspection-tripwire.cjs");
      const sentinel = nodePath.join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
      const probe = nodePath.join(fixtureRoot, "compiler-connection.mjs");

      const sessionUrl = new URL(
        "../src/inspection/compiler-session.ts",
        import.meta.url
      ).href;

      const declaration = "export type Connected = true;";
      await writeFile(
        probe,
        [
          `import { CompilerSession } from ${JSON.stringify(sessionUrl)};`,
          "const session = new CompilerSession();",
          "try {",
          `  const lease = session.api.createSourceFile(${JSON.stringify(nodePath.join(fixtureRoot, "connected.d.ts"))}, ${JSON.stringify(declaration)});`,
          "  try { process.stdout.write(lease.sourceFile.getText()); }",
          "  finally { lease[Symbol.dispose](); }",
          "} finally { session.close(); }",
        ].join("\n")
      );

      const result = await execa(process.execPath, [probe], {
        cwd: fixtureRoot,
        env: {
          NODE_OPTIONS: staticInspectionNodeOptions(preload, sentinel).join(
            " "
          ),
          TYPEPEEK_ALLOWED_ANALYSIS_PROCESS_ENTRY: probe,
          TYPEPEEK_ALLOWED_COMPILER_EXECUTABLE: COMPILER_EXECUTABLE,
          TYPEPEEK_DENY_WORKERS: "true",
          TYPEPEEK_IO_SENTINEL: sentinel,
        },
      });

      expect(result.stdout).toBe(declaration);
      await inspection.verifyNoIo();
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("permits Windows compiler pipe writes while denying unrelated paths", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-compiler-permissions-")
    );

    try {
      await materializeStaticInspection(fixtureRoot);
      const preload = nodePath.join(fixtureRoot, "inspection-tripwire.cjs");
      const sentinel = nodePath.join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
      const probe = nodePath.join(fixtureRoot, "pipe-permissions.mjs");
      await writeFile(
        probe,
        [
          "const canWrite = (path) => process.permission.has('fs.write', path);",
          "process.stdout.write(JSON.stringify([",
          "  canWrite(String.raw`\\\\.\\pipe\\tsgo-sync-123-abcd`),",
          "  canWrite(String.raw`\\\\.\\pipe\\other-123-abcd`),",
          `  canWrite(${JSON.stringify(nodePath.join(fixtureRoot, "unrelated"))}),`,
          "]));",
        ].join("\n")
      );

      const result = await execa(process.execPath, [probe], {
        env: {
          NODE_OPTIONS: staticInspectionNodeOptions(
            preload,
            sentinel,
            "win32"
          ).join(" "),
        },
      });

      expect(result.stdout).toBe("[true,false,false]");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["accepts the pinned SDK Windows pipe transport", "native", 0],
    ["opens the compiler pipe without canonicalizing it", "open-pipe", 0],
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
          'import { openSync, realpathSync } from "node:fs";',
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
          "if (variant === 'open-pipe') {",
          "  const originalRealpath = realpathSync.native;",
          "  let pipeCanonicalizations = 0;",
          "  realpathSync.native = function(file, ...rest) {",
          "    if (String(file).includes('tsgo-sync-')) pipeCanonicalizations += 1;",
          "    return originalRealpath(file, ...rest);",
          "  };",
          "  try { openSync(args[6], 'r+'); } catch {}",
          "  realpathSync.native = originalRealpath;",
          "  if (pipeCanonicalizations !== 0) throw new Error('Canonicalization consumed the compiler pipe connection');",
          "}",
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
