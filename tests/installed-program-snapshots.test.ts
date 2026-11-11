import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { createCompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { InstalledProgramLoader } from "#typepeek/inspection/compiler/installed-program-loader";
import { requireDefined } from "#typepeek/shared/defined-value";

describe("Installed Evidence snapshot updates", () => {
  it("transfers only new contents while preserving old files and checker handles", async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "typepeek-snapshot-deltas-"))
    );

    try {
      const packageRoot = nodePath.join(root, "package");
      await mkdir(packageRoot);
      const first = nodePath.join(packageRoot, "first.d.ts");
      const second = nodePath.join(packageRoot, "second.d.ts");

      const firstText =
        "export interface Original { readonly originalSnapshotOnly: true; }";

      await writeFile(first, firstText);
      await writeFile(
        second,
        "export interface Added { readonly addedSnapshotOnly: true; }"
      );
      await writeFile(
        nodePath.join(packageRoot, "package.json"),
        '{"name":"snapshot-fixture","version":"1.0.0","type":"module"}'
      );
      const work = createCompilerWorkSession();

      const snapshots = vi.spyOn(work.native.api, "createSnapshot");
      const loader = new InstalledProgramLoader([packageRoot], work);
      const before = await loader.createProgram([first], false);
      const source = requireDefined(await before.getSourceFile(first));
      const { checker } = before.getProject();

      const symbol = requireDefined(await checker.getSymbolAtLocation(source));

      const [initial] = snapshots.mock.results;

      if (initial?.type !== "return") {
        throw new Error("The initial native snapshot was not created.");
      }

      const initialSnapshot = await initial.value;

      const update = vi.spyOn(initialSnapshot, "update");

      try {
        const after = await loader.createProgram([first, second], true);
        const layer = JSON.stringify(update.mock.calls[0]?.[0].fileSystem);
        expect(layer).toContain("addedSnapshotOnly");
        expect(layer).not.toContain("originalSnapshotOnly");
        const firstSource = await after.getSourceFile(first);
        expect(firstSource?.getText()).toBe(firstText);
        const secondSource = await after.getSourceFile(second);
        expect(secondSource?.getText()).toContain("Added");
        const exportsOfModule = await checker.getExportsOfModule(symbol);
        expect(exportsOfModule.map((item) => item.name)).toStrictEqual([
          "Original",
        ]);
      } finally {
        update.mockRestore();
        snapshots.mockRestore();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
