import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { canonicalEvidenceCandidatePath } from "#typepeek/inspection/evidence-boundary";
import {
  createInstalledEvidenceFingerprintRecorder,
  MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
} from "#typepeek/inspection/installed-evidence-fingerprint";

describe("compiler work session", () => {
  it("stops recording filesystem evidence once the proof cannot fit its byte budget", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-recording-budget-"));
    try {
      const containingFile = join(await realpath(fixtureRoot), "index.d.ts");
      const recorder = createInstalledEvidenceFingerprintRecorder();
      for (let index = 0; index < 32; index += 1) {
        recorder.observeResolution({
          allowedRoots: [],
          containingFile,
          kind: "module",
          specifier: `${index}-${"x".repeat(3_000)}`,
        });
      }
      expect(recorder.snapshot()).toBeUndefined();
      expect(() =>
        recorder.observeResolution({
          allowedRoots: [],
          get containingFile(): string {
            throw new Error("Uncacheable evidence must not trigger another filesystem probe.");
          },
          kind: "module",
          specifier: "next",
        }),
      ).not.toThrow();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("retains the exact proof byte limit without charging duplicate observations", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-exact-budget-"));
    try {
      const containingFile = join(await realpath(fixtureRoot), "index.d.ts");
      await writeFile(containingFile, "export type Value = string;");
      const recorder = createInstalledEvidenceFingerprintRecorder();
      const entries = await readdir(fixtureRoot, { withFileTypes: true });
      for (let repetition = 0; repetition < 2; repetition += 1) {
        recorder.observeFile(containingFile, "export type Value = string;", "declaration");
        recorder.observeDirectory(fixtureRoot, entries);
      }
      const probe = (specifier: string) => ({
        allowedRoots: [],
        containingFile,
        kind: "module" as const,
        specifier,
      });
      let nextIndex = 0;
      while (true) {
        const before = recorder.snapshot()!;
        const next = probe(`${nextIndex}-${"🌍".repeat(600)}`);
        if (
          Buffer.byteLength(
            JSON.stringify({ ...before, resolutions: [...before.resolutions, next] }),
          ) > MAX_INSTALLED_EVIDENCE_PROOF_BYTES
        )
          break;
        recorder.observeResolution(next);
        recorder.observeResolution(next);
        nextIndex += 1;
      }
      const before = recorder.snapshot()!;
      const withEmpty = { ...before, resolutions: [...before.resolutions, probe("")] };
      const remaining =
        MAX_INSTALLED_EVIDENCE_PROOF_BYTES - Buffer.byteLength(JSON.stringify(withEmpty));
      const finalProbe = probe("z".repeat(remaining));
      recorder.observeResolution(finalProbe);
      recorder.observeResolution(finalProbe);
      expect(Buffer.byteLength(JSON.stringify(recorder.snapshot()))).toBe(
        MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
      );
      recorder.observeResolution(probe("overflow"));
      expect(recorder.snapshot()).toBeUndefined();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

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

  it("preserves UTF-8 across large reads and rejects the first byte beyond the budget", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-chunked-evidence-"));
    try {
      const fileName = join(fixtureRoot, "declaration.txt");
      const text = "x".repeat(65_535) + "🌍" + "y".repeat(65_535);
      await writeFile(fileName, text);
      const bytes = Buffer.byteLength(text);
      expect(
        createCompilerWorkSession({ resolutionBytes: bytes }).readResolutionFile(fileName),
      ).toBe(text);
      expect(() =>
        createCompilerWorkSession({ resolutionBytes: bytes - 1 }).readResolutionFile(fileName),
      ).toThrow("Inspection exceeded its compiler host byte limit.");
      await writeFile(fileName, "");
      expect(createCompilerWorkSession({ resolutionBytes: 0 }).readResolutionFile(fileName)).toBe(
        "",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
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
