import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { analyzeInspection, type AnalysisExecution } from "#typepeek/inspection/analyze";
import { selectInspectableModule } from "#typepeek/inspection/installed-evidence";
import {
  createInstalledEvidenceFingerprintRecorder,
  type InstalledEvidenceProof,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import { EVIDENCE_PROOF_LIMITS } from "#typepeek/inspection/installed-evidence-format";
import { installedEvidenceProofStillMatches } from "#typepeek/inspection/installed-evidence-proof";

describe("Installed Evidence Proof replay", () => {
  it.each([
    "implicit-module",
    "implicit-type-reference",
    "explicit-mode",
    "no-probe",
    "fixed-extension",
    "new-package-scope",
  ])("rechecks declaration format and manifest scope for %s", async (scenario) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-source-format-"));
    try {
      const root = await realpath(fixtureRoot);
      const packageRoot = join(root, "node_modules", "entry");
      const dependencyRoot = join(root, "node_modules", "conditional");
      const declarationName = scenario === "fixed-extension" ? "index.d.mts" : "index.d.ts";
      const declarationPath = join(packageRoot, "dist", "nested", declarationName);
      const typeReference = scenario === "implicit-type-reference";
      const declaration = typeReference
        ? '/// <reference types="conditional" />\nexport interface Value extends Selected {}'
        : scenario === "explicit-mode"
          ? 'export type Value = import("conditional", { with: { "resolution-mode": "require" } }).Value;'
          : scenario === "no-probe"
            ? "export interface Value { fixedOnly: true }"
            : 'export { Value } from "conditional";';
      await Promise.all([
        mkdir(join(packageRoot, "dist", "nested"), { recursive: true }),
        mkdir(dependencyRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" })),
        writeFile(
          join(packageRoot, "package.json"),
          JSON.stringify({
            name: "entry",
            version: "1.0.0",
            types: `dist/nested/${declarationName}`,
            dependencies: { conditional: "1.0.0" },
          }),
        ),
        writeFile(declarationPath, declaration),
        writeFile(
          join(dependencyRoot, "package.json"),
          JSON.stringify({
            name: "conditional",
            version: "1.0.0",
            exports: { import: "./import.d.ts", require: "./require.d.ts" },
          }),
        ),
        ...["import", "require"].map((mode) =>
          writeFile(
            join(dependencyRoot, `${mode}.d.ts`),
            `${typeReference ? "interface Selected" : "export interface Value"} { ${mode}Only: true }`,
          ),
        ),
      ]);
      const request = {
        intent: "member-discovery",
        request: {
          accessStyle: "import",
          resolutionContext: root,
          specifier: "entry",
          exportName: "Value",
          memberPath: [],
        },
      } as const;
      const currentSelectionProof = () => {
        const recorder = createInstalledEvidenceFingerprintRecorder();
        expect(selectInspectableModule(request.request, recorder)).toBeDefined();
        return recorder.snapshot()!;
      };
      const before = analyzeInspection(request, false);
      const proof = successfulProof(before);
      const beforeName =
        scenario === "fixed-extension"
          ? "importOnly"
          : scenario === "no-probe"
            ? "fixedOnly"
            : "requireOnly";
      expect(before.outcome).toMatchObject({
        status: "success",
        result: { members: [{ name: beforeName }] },
      });
      expect(proof.files.find(({ path }) => path === declarationPath)?.sourceFormat).toEqual({
        accessStyle: scenario === "fixed-extension" ? "import" : "require",
        path: declarationPath,
      });
      expect(installedEvidenceProofStillMatches(proof, currentSelectionProof())).toBe(true);
      if (scenario === "no-probe") {
        const signatureProof = successfulProof(
          analyzeInspection(
            {
              intent: "signature-inspection",
              request: {
                accessStyle: "import",
                resolutionContext: root,
                specifier: "entry",
                exportName: "Value",
              },
            },
            false,
          ),
        );
        const libraryFiles = signatureProof.files.filter(({ path }) => path.includes("/lib.es"));
        expect(libraryFiles.length).toBeGreaterThan(0);
        expect(libraryFiles.every(({ sourceFormat }) => sourceFormat === undefined)).toBe(true);
        expect(installedEvidenceProofStillMatches(signatureProof, currentSelectionProof())).toBe(
          true,
        );
      }

      // A new manifest can change inferred format or the dependency declaration authority.
      await writeFile(
        join(packageRoot, "dist", "package.json"),
        JSON.stringify(
          scenario === "new-package-scope"
            ? { name: "inner", version: "1.0.0" }
            : { type: "module" },
        ),
      );
      expect(installedEvidenceProofStillMatches(proof, currentSelectionProof())).toBe(false);
      const after = analyzeInspection(request, false);
      if (scenario === "new-package-scope") {
        expect(after.outcome).toMatchObject({
          status: "unsupported",
          reason: "unsupported-evidence",
        });
        return;
      }
      const afterName = scenario === "implicit-module" || typeReference ? "importOnly" : beforeName;
      expect(after.outcome).toMatchObject({
        status: "success",
        result: { members: [{ name: afterName }] },
      });
      const afterProof = successfulProof(after);
      expect(installedEvidenceProofStillMatches(afterProof, currentSelectionProof())).toBe(true);
      if (scenario === "explicit-mode") {
        expect(afterProof.resolutions).toContainEqual(
          expect.objectContaining({ specifier: "conditional", accessStyle: "require" }),
        );
        expect(
          afterProof.files.find(({ path }) => path === declarationPath)?.sourceFormat?.accessStyle,
        ).toBe("import");
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([".pnp.cjs", ".pnp.js", "pnpm-workspace.yaml"])(
    "replays observed absence of %s installation metadata",
    async (marker) => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-installation-marker-"));
      try {
        const root = await realpath(fixtureRoot);
        const packageRoot = join(root, "node_modules", "entry");
        const dependencyRoot = join(root, "node_modules", "dependency");
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await mkdir(dependencyRoot, { recursive: true });
        await Promise.all([
          writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" })),
          writeFile(
            join(packageRoot, "package.json"),
            JSON.stringify({
              name: "entry",
              version: "1.0.0",
              types: "dist/index.d.ts",
              dependencies: { dependency: "1.0.0" },
            }),
          ),
          writeFile(join(packageRoot, "dist", "index.d.ts"), 'export { Value } from "dependency";'),
          writeFile(
            join(dependencyRoot, "package.json"),
            JSON.stringify({ name: "dependency", version: "1.0.0", types: "index.d.ts" }),
          ),
          writeFile(join(dependencyRoot, "index.d.ts"), "export interface Value { value: string }"),
        ]);
        const request = {
          intent: "member-discovery",
          request: {
            accessStyle: "import",
            resolutionContext: root,
            specifier: "entry",
            exportName: "Value",
            memberPath: [],
          },
        } as const;
        const proof = successfulProof(analyzeInspection(request, false));
        const markerPath = join(
          packageRoot,
          ...(marker === "pnpm-workspace.yaml" ? [] : ["dist"]),
          marker,
        );
        expect(proof.fileChecks).toContainEqual({ path: markerPath, exists: false });
        expect(installedEvidenceProofStillMatches(proof, proof)).toBe(true);
        await writeFile(markerPath, "");
        expect(installedEvidenceProofStillMatches(proof, proof)).toBe(false);
        if (marker !== "pnpm-workspace.yaml") {
          expect(analyzeInspection(request, false).outcome.status).toBe("unsupported");
        }
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects a retargeted manifest symlink that changes dependency authority", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-manifest-symlink-"));
    try {
      const root = await realpath(fixtureRoot);
      const packageRoot = join(root, "node_modules", "entry");
      const dependencyRoot = join(root, "node_modules", "dependency");
      const scopePath = join(packageRoot, "dist", "package.json");
      const oldTarget = join(packageRoot, "config", "old.json");
      const newTarget = join(packageRoot, "config", "new.json");
      await Promise.all([
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(join(packageRoot, "config"), { recursive: true }),
        mkdir(dependencyRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" })),
        writeFile(
          join(packageRoot, "package.json"),
          JSON.stringify({
            name: "entry",
            version: "1.0.0",
            types: "dist/index.d.ts",
            dependencies: { dependency: "1.0.0" },
          }),
        ),
        writeFile(join(packageRoot, "dist", "index.d.ts"), 'export { Value } from "dependency";'),
        writeFile(
          join(dependencyRoot, "package.json"),
          JSON.stringify({ name: "dependency", version: "1.0.0", types: "index.d.ts" }),
        ),
        writeFile(join(dependencyRoot, "index.d.ts"), "export interface Value { value: string }"),
        writeFile(
          oldTarget,
          JSON.stringify({
            name: "inner",
            version: "1.0.0",
            dependencies: { dependency: "1.0.0" },
          }),
        ),
        writeFile(newTarget, JSON.stringify({ name: "inner", version: "1.0.0" })),
      ]);
      await symlink(oldTarget, scopePath);
      const request = {
        intent: "member-discovery",
        request: {
          accessStyle: "import",
          resolutionContext: root,
          specifier: "entry",
          exportName: "Value",
          memberPath: [],
        },
      } as const;
      const currentSelectionProof = () => {
        const recorder = createInstalledEvidenceFingerprintRecorder();
        expect(selectInspectableModule(request.request, recorder)).toBeDefined();
        return recorder.snapshot()!;
      };
      const proof = successfulProof(analyzeInspection(request, false));
      expect(proof.fileChecks).toContainEqual({
        path: scopePath,
        exists: true,
        canonicalPath: oldTarget,
      });
      expect(installedEvidenceProofStillMatches(proof, currentSelectionProof())).toBe(true);
      await unlink(scopePath);
      await symlink(newTarget, scopePath);
      expect(analyzeInspection(request, false).outcome).toMatchObject({
        status: "unsupported",
        reason: "unsupported-evidence",
      });
      expect(installedEvidenceProofStillMatches(proof, currentSelectionProof())).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("bounds unique file checks and disables contradictory receipts", () => {
    const recorder = createInstalledEvidenceFingerprintRecorder();
    for (let index = 0; index < EVIDENCE_PROOF_LIMITS.fileChecks; index += 1) {
      const path = join(tmpdir(), "typepeek-presence-budget", String(index));
      recorder.observeFilePresence(path, false);
      recorder.observeFilePresence(path, false);
    }
    expect(recorder.snapshot()?.fileChecks).toHaveLength(EVIDENCE_PROOF_LIMITS.fileChecks);
    recorder.observeFilePresence(join(tmpdir(), "typepeek-presence-budget", "overflow"), false);
    expect(recorder.snapshot()).toBeUndefined();
    const conflicting = createInstalledEvidenceFingerprintRecorder();
    const path = join(tmpdir(), "typepeek-presence-conflict");
    conflicting.observeFilePresence(path, false);
    conflicting.observeFilePresence(path, true);
    expect(conflicting.snapshot()).toBeUndefined();
  });

  it("replays format through a proved logical package root and rejects conflicting observations", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-proof-logical-format-"));
    try {
      const root = await realpath(fixtureRoot);
      const packageRoot = join(root, "workspace-package");
      const logicalRoot = join(root, "node_modules", "linked");
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await mkdir(join(root, "node_modules"), { recursive: true });
      await symlink(packageRoot, logicalRoot, process.platform === "win32" ? "junction" : "dir");
      const manifest = JSON.stringify({
        name: "linked",
        version: "1.0.0",
        types: "dist/index.d.ts",
      });
      const declaration = "export declare const value: 1;";
      const declarationPath = join(packageRoot, "dist", "index.d.ts");
      const logicalPath = join(logicalRoot, "dist", "index.d.ts");
      await writeFile(join(packageRoot, "package.json"), manifest);
      await writeFile(declarationPath, declaration);
      const recorder = createInstalledEvidenceFingerprintRecorder();
      recorder.observeFile(join(packageRoot, "package.json"), manifest, "manifest");
      recorder.observeFile(declarationPath, declaration, "declaration", {
        accessStyle: "require",
        path: logicalPath,
      });
      recorder.observeResolution({
        accessStyle: "import",
        allowedRoots: [logicalRoot],
        containingFile: join(root, "consumer.mts"),
        kind: "module",
        specifier: "linked",
        resolvedPath: declarationPath,
      });
      const proof = recorder.snapshot()!;
      expect(installedEvidenceProofStillMatches(proof, proof)).toBe(true);
      await writeFile(
        join(packageRoot, "dist", "package.json"),
        JSON.stringify({ type: "module" }),
      );
      expect(installedEvidenceProofStillMatches(proof, proof)).toBe(false);
      recorder.observeFile(declarationPath, declaration, "declaration", {
        accessStyle: "import",
        path: declarationPath,
      });
      expect(recorder.snapshot()).toBeUndefined();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

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

function successfulProof(execution: AnalysisExecution): InstalledEvidenceProof {
  expect(execution.outcome.status, JSON.stringify(execution.outcome)).toBe("success");
  const { cacheMessage } = execution;
  if (cacheMessage?.kind !== "inspection-cache-write") {
    throw new Error("Successful analysis did not retain an Installed Evidence Proof.");
  }
  return cacheMessage.proof;
}
