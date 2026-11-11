import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { selectCliWorkspace } from "#typepeek/cli/cli-workspace";
import { processLayer } from "#typepeek/platform/process-runtime";

const findDeclaredWorkspace = (directory: string, reads: string[]) =>
  Effect.gen(function* selectWorkspace() {
    const fs = yield* FileSystem.FileSystem;

    return yield* selectCliWorkspace(
      "declared-package",
      undefined,
      "--workspace",
      directory
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stat: (path) => {
          reads.push(path);

          return fs.stat(path);
        },
      })
    );
  }).pipe(Effect.provide(processLayer));

describe("consuming workspace selection", () => {
  it.each(["workspace-config", "ancestor-manifest"])(
    "keeps a declared dependency in the current Resolution Context despite oversized %s",
    async (unrelated) => {
      const temporary = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-workspace-selection-")
      );

      const root = await realpath(temporary);
      const directory = nodePath.join(root, "consumer");
      await mkdir(directory);
      const manifestPath = nodePath.join(directory, "package.json");

      try {
        await writeFile(
          manifestPath,
          JSON.stringify({
            dependencies: { "declared-package": "1.0.0" },
            name: "consumer",
          })
        );
        await writeFile(
          unrelated === "workspace-config"
            ? nodePath.join(directory, "pnpm-workspace.yaml")
            : nodePath.join(root, "package.json"),
          "x".repeat(256 * 1024 + 1)
        );
        const reads: string[] = [];

        const selection = await Effect.runPromise(
          findDeclaredWorkspace(directory, reads)
        );

        expect(selection).toBe(directory);
        expect(reads).toStrictEqual([manifestPath]);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );
});
