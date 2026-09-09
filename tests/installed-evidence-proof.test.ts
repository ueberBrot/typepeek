import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/installed-evidence-fingerprint";
import { installedEvidenceProofStillMatches } from "#typepeek/inspection/installed-evidence-proof";

describe("Installed Evidence Proof replay", () => {
  it.each(["module", "type-reference"] as const)(
    "preserves import and require conditions within one %s proof",
    async (kind) => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-conditions-"));
      try {
        const root = await realpath(fixtureRoot);
        const packageRoot = join(root, "node_modules", "dual");
        await mkdir(packageRoot, { recursive: true });
        const recorder = createInstalledEvidenceFingerprintRecorder();
        const manifestPath = join(packageRoot, "package.json");
        const manifest = JSON.stringify({
          name: "dual",
          exports: { import: "./index.d.mts", require: "./index.d.cts" },
        });
        await writeFile(manifestPath, manifest);
        recorder.observeFile(manifestPath, manifest, "manifest");
        for (const accessStyle of ["import", "require"] as const) {
          const declarationPath = join(
            packageRoot,
            accessStyle === "import" ? "index.d.mts" : "index.d.cts",
          );
          const declaration = `export declare const mode: "${accessStyle}";`;
          await writeFile(declarationPath, declaration);
          recorder.observeFile(declarationPath, declaration, "declaration");
          recorder.observeResolution({
            accessStyle,
            allowedRoots: [packageRoot],
            containingFile: join(root, "consumer.ts"),
            kind,
            resolvedPath: declarationPath,
            specifier: "dual",
          });
        }
        const proof = recorder.snapshot()!;
        expect(installedEvidenceProofStillMatches(proof, proof)).toBe(true);
        expect(
          installedEvidenceProofStillMatches(
            { ...proof, resolutions: [...proof.resolutions].reverse() },
            proof,
          ),
        ).toBe(true);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("separates root permissions and refreshes missing declarations between replays", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-capabilities-"));
    try {
      const root = await realpath(fixtureRoot);
      const recorder = createInstalledEvidenceFingerprintRecorder();
      const manifestPath = join(root, "package.json");
      const manifest = JSON.stringify({ name: "local-evidence", type: "module" });
      await writeFile(manifestPath, manifest);
      recorder.observeFile(manifestPath, manifest, "manifest");
      const declarationPath = join(root, "present.d.ts");
      await writeFile(declarationPath, "export declare const value: 1;");
      const containingFile = join(root, "consumer.mts");
      for (const allowed of [true, false]) {
        recorder.observeResolution({
          allowedRoots: allowed ? [root] : [],
          containingFile,
          kind: "module",
          ...(allowed ? { resolvedPath: declarationPath } : {}),
          specifier: "./present.js",
        });
      }
      recorder.observeResolution({
        allowedRoots: [root],
        containingFile,
        kind: "module",
        specifier: "./future.js",
      });
      const proof = recorder.snapshot()!;
      expect(installedEvidenceProofStillMatches(proof, proof)).toBe(true);
      expect(
        installedEvidenceProofStillMatches(
          { ...proof, resolutions: [...proof.resolutions].reverse() },
          proof,
        ),
      ).toBe(true);

      await writeFile(join(root, "future.d.ts"), "export declare const value: 2;");
      expect(installedEvidenceProofStillMatches(proof, proof)).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts unchanged evidence and rejects changed evidence through one interface", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-replay-"));
    try {
      const evidencePath = join(await realpath(fixtureRoot), "index.d.ts");
      const original = "export declare const value: 1;\n";
      await writeFile(evidencePath, original);
      const recorder = createInstalledEvidenceFingerprintRecorder();
      recorder.observeFile(evidencePath, original, "declaration");
      const proof = recorder.snapshot();

      expect(proof).toBeDefined();
      if (proof === undefined) {
        return;
      }
      expect(installedEvidenceProofStillMatches(proof, proof)).toBe(true);

      await writeFile(evidencePath, "export declare const value: 2;\n");
      expect(installedEvidenceProofStillMatches(proof, proof)).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
