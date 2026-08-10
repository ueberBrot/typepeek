import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";

describe("compiler work session", () => {
  it("allows the exact aggregate limits and rejects the next work", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-compiler-session-"));
    try {
      const firstFile = join(fixtureRoot, "first.txt");
      const secondFile = join(fixtureRoot, "second.txt");
      const overflowFile = join(fixtureRoot, "overflow.txt");
      await Promise.all([
        writeFile(firstFile, "12"),
        writeFile(secondFile, "34"),
        writeFile(overflowFile, "5"),
      ]);
      const byteSession = createCompilerWorkSession({ resolutionBytes: 4 });
      expect(byteSession.readResolutionFile(firstFile)).toBe("12");
      expect(byteSession.readResolutionFile(secondFile)).toBe("34");
      expect(() => byteSession.readResolutionFile(overflowFile)).toThrow(
        "Inspection exceeded its compiler host byte limit.",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }

    const operationSession = createCompilerWorkSession({ operations: 2 });
    operationSession.reserveOperations();
    operationSession.reserveOperations();
    expect(() => operationSession.reserveOperations()).toThrow(
      "Inspection exceeded its compiler host work limit.",
    );
  });

  it("bounds package resolution before it can return authoritative evidence", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-resolution-budget-"));
    const packageRoot = join(fixtureRoot, "node_modules", "bounded-package");
    try {
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      const manifest = {
        name: "bounded-package",
        version: "1.0.0",
        types: "./dist/index.d.ts",
      };
      await Promise.all([
        writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest)),
        writeFile(join(packageRoot, "dist", "index.d.ts"), "export declare const value: 1;\n"),
      ]);
      const session = createCompilerWorkSession({ resolutionBytes: 8 });
      const resolver = session.createPackageResolver(fixtureRoot, "import");
      expect(() => resolver.resolve("bounded-package")).toThrow(
        "Inspection exceeded its compiler host byte limit.",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
