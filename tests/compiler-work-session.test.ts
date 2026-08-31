import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { canonicalEvidenceCandidatePath } from "#typepeek/inspection/evidence-boundary";
import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/installed-evidence-fingerprint";

describe("compiler work session", () => {
  it("retains unresolved probes with no filesystem capability", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-empty-resolution-capability-"));
    try {
      const containingFile = join(await realpath(fixtureRoot), "index.d.ts");
      const recorder = createInstalledEvidenceFingerprintRecorder();
      recorder.observeResolution({
        allowedRoots: [],
        containingFile,
        kind: "module",
        specifier: "node:missing",
      });

      expect(recorder.snapshot()).toEqual({
        directories: [],
        files: [],
        resolutions: [
          {
            allowedRoots: [],
            containingFile,
            kind: "module",
            specifier: "node:missing",
          },
        ],
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("bounds missing-path canonicalization depth", () => {
    const deeplyMissingPath = join(
      tmpdir(),
      ...Array.from({ length: 300 }, (_, index) => `missing-${index}`),
    );

    expect(() => canonicalEvidenceCandidatePath(deeplyMissingPath)).toThrow(
      "Inspection exceeded its compiler host work limit.",
    );
  });

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
      const resolver = session.createPackageResolver(fixtureRoot, "import", [packageRoot]);
      expect(() => resolver.resolve("bounded-package")).toThrow(
        "Inspection exceeded its compiler host byte limit.",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("resolves only through explicitly allowed declaration roots", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-resolution-authority-"));
    const contextRoot = join(fixtureRoot, "workspace", "project");
    const allowedRoot = join(fixtureRoot, "node_modules", "bounded-package");
    const nearerRoot = join(contextRoot, "node_modules", "bounded-package");
    try {
      await Promise.all([
        mkdir(join(allowedRoot, "dist"), { recursive: true }),
        mkdir(join(nearerRoot, "dist"), { recursive: true }),
      ]);
      const manifest = JSON.stringify({
        name: "bounded-package",
        version: "1.0.0",
        types: "./dist/index.d.ts",
      });
      await Promise.all([
        writeFile(join(allowedRoot, "package.json"), manifest),
        writeFile(join(allowedRoot, "dist", "index.d.ts"), "export declare const allowed: 1;\n"),
        writeFile(join(nearerRoot, "package.json"), manifest),
        writeFile(join(nearerRoot, "dist", "index.d.ts"), "export declare const nearer: 1;\n"),
      ]);

      const resolver = createCompilerWorkSession().createPackageResolver(contextRoot, "import", [
        allowedRoot,
      ]);

      expect(resolver.resolve("bounded-package")).toBe(
        await realpath(join(allowedRoot, "dist", "index.d.ts")),
      );
      expect(
        createCompilerWorkSession().resolveEvidenceProbe(
          {
            accessStyle: "import",
            containingFile: join(contextRoot, "index.mts"),
            kind: "module",
            specifier: "bounded-package",
          },
          [contextRoot, allowedRoot],
        ),
      ).toBe(await realpath(join(allowedRoot, "dist", "index.d.ts")));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
