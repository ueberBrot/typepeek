import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveCompilerLibraryDirectory } from "#typepeek/inspection/compiler/compiler-distribution";
import { runCommand } from "#typepeek/platform/process-command";
import { processLayer } from "#typepeek/platform/process-runtime";
import { decodeJson } from "#typepeek/shared/json-data";

const deniedCompilerHook = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@tsrs/')) throw new Error('Native compiler is unavailable');
  return nextResolve(specifier, context);
} });`;

const withoutCompiler = async (args: readonly string[]) =>
  await runCommand(process.execPath, ["src/cli.ts", ...args], {
    env: {
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(deniedCompilerHook)}`,
      TYPEPEEK_CACHE_BYPASS: "1",
    },
    reject: false,
  });

describe("compiler identity and distribution", () => {
  it.each([["--help"], ["--version"], ["capabilities", "--json"]])(
    "serves metadata without resolving the native compiler: %s",
    async (...args) => {
      const result = await withoutCompiler(args);
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      });
      expect(result.stdout.length).toBeGreaterThan(0);
    }
  );

  it("keeps missing native compiler failures inside inspection execution", async () => {
    const result = await withoutCompiler([
      "signatures",
      "semver",
      "clean",
      "--json",
    ]);

    expect(result).toMatchObject({ failed: true, timedOut: false });
    expect(
      decodeJson(
        Schema.Struct({ reason: Schema.String, status: Schema.String }),
        result.stdout
      )
    ).toMatchObject({
      reason: "analysis-terminated",
      status: "unsupported",
    });
  });

  it.each([
    ["gnu", false],
    ["musl", false],
    ["gnu", true],
    ["musl", true],
  ] as const)(
    "uses the pinned %s selection with embedded platform=%s when both Linux variants exist",
    async (libc, embedded) => {
      const root = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-compiler-platform-")
      );

      const sdk = nodePath.join(root, "node_modules", "tsrs");
      const selected = `@tsrs/linux-x64-${libc}`;
      const executable = process.platform === "win32" ? "tsrs.exe" : "tsrs";

      try {
        vi.stubGlobal(
          "__TYPEPEEK_COMPILER_PLATFORM__",
          embedded ? selected : undefined
        );
        await mkdir(nodePath.join(sdk, "lib"), { recursive: true });
        await writeFile(
          nodePath.join(sdk, "package.json"),
          JSON.stringify({
            exports: { "./package.json": "./package.json" },
            name: "tsrs",
            type: "module",
          })
        );
        await writeFile(
          nodePath.join(sdk, "lib", "platform.js"),
          embedded
            ? 'throw new Error("Compiled runtime must not load platform code from disk.");'
            : `export const getPlatformPackageName = () => ${JSON.stringify(selected)};`
        );

        await Promise.all(
          ["gnu", "musl"].map(async (variant) => {
            const directory = nodePath.join(
              root,
              "node_modules",
              "@tsrs",
              `linux-x64-${variant}`
            );

            await mkdir(directory, { recursive: true });
            await writeFile(
              nodePath.join(directory, "package.json"),
              JSON.stringify({ name: `@tsrs/linux-x64-${variant}` })
            );
            await writeFile(nodePath.join(directory, executable), "");
          })
        );

        const anchor = pathToFileURL(nodePath.join(root, "entry.js"));

        const resolution = resolveCompilerLibraryDirectory(anchor).pipe(
          Effect.provide(processLayer)
        );

        const expected = await realpath(
          nodePath.join(root, "node_modules", ...selected.split("/"))
        );

        await expect(Effect.runPromise(resolution)).resolves.toBe(expected);
        await rm(nodePath.join(expected, executable));
        await expect(Effect.runPromise(resolution)).rejects.toThrow(
          /missing/iu
        );
      } finally {
        vi.unstubAllGlobals();
        await rm(root, { force: true, recursive: true });
      }
    }
  );
});
