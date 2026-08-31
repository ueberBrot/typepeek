import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/installed-evidence-fingerprint";
import { installedEvidenceProofStillMatches } from "#typepeek/inspection/installed-evidence-proof";

describe("Installed Evidence Proof replay", () => {
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
