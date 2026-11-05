import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { InstalledProgramLoader } from "#typepeek/inspection/installed-program-loader";

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
      expect(work.native.api.createSnapshot).toBeTypeOf("function");
      const snapshots = vi.spyOn(work.native.api, "createSnapshot");
      const loader = new InstalledProgramLoader([packageRoot], work);
      const before = loader.createProgram([first], false);
      const source = requireDefined(before.getSourceFile(first));
      const { checker } = before.getProject();
      const symbol = requireDefined(checker.getSymbolAtLocation(source));
      const [initial] = snapshots.mock.results;

      if (initial?.type !== "return") {
        throw new Error("The initial native snapshot was not created.");
      }

      expect(initial.value.update).toBeTypeOf("function");
      const update = vi.spyOn(initial.value, "update");

      try {
        const after = loader.createProgram([first, second], true);
        const layer = JSON.stringify(update.mock.calls[0]?.[0].fileSystem);
        expect(layer).toContain("addedSnapshotOnly");
        expect(layer).not.toContain("originalSnapshotOnly");
        expect(after.getSourceFile(first)?.getText()).toBe(firstText);
        expect(after.getSourceFile(second)?.getText()).toContain("Added");
        expect(
          checker.getExportsOfModule(symbol).map((item) => item.name)
        ).toStrictEqual(["Original"]);
      } finally {
        update.mockRestore();
        snapshots.mockRestore();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
