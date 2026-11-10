import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { selectInspectableModule } from "#typepeek/inspection/evidence/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { EVIDENCE_PROOF_LIMITS } from "#typepeek/inspection/evidence/installed-evidence-format";
import { installedEvidenceProofStillMatches } from "#typepeek/inspection/evidence/installed-evidence-proof";
import type { AnalysisExecution } from "#typepeek/inspection/execution/analyze";
import { analyzeInspection } from "#typepeek/inspection/execution/analyze";
import type { NormalizedInspectionTarget } from "#typepeek/inspection/model/protocol";
import { requireDefined } from "#typepeek/shared/defined-value";

import { match } from "./helpers/matchers.ts";

const currentSelectionProof = async (
  target: NormalizedInspectionTarget
): Promise<InstalledEvidenceProof> => {
  const recorder = createInstalledEvidenceFingerprintRecorder();
  await expect(
    selectInspectableModule(target, recorder)
  ).resolves.toBeDefined();

  return requireDefined(recorder.snapshot());
};

const assertStandardLibraryProof = async (
  proof: InstalledEvidenceProof,
  current: InstalledEvidenceProof
): Promise<void> => {
  const libraryFiles = proof.files.filter(({ path }) =>
    path.includes("/lib.es")
  );

  expect([
    libraryFiles.length > 0,
    libraryFiles.every(({ sourceFormat }) => sourceFormat === undefined),
    await installedEvidenceProofStillMatches(proof, current),
  ]).toStrictEqual([true, true, true]);
};

const assertExplicitResolutionProof = (
  proof: InstalledEvidenceProof,
  declarationPath: string
): void => {
  expect(proof.resolutions).toContainEqual(
    match.objectContaining({ accessStyle: "require", specifier: "conditional" })
  );
  expect(
    proof.files.find(({ path }) => path === declarationPath)?.sourceFormat
      ?.accessStyle
  ).toBe("import");
};

const assertUnsupportedAnalysis = (execution: AnalysisExecution): void => {
  expect(execution.outcome.status).toBe("unsupported");
};

const successfulProof = function successfulProof(
  execution: AnalysisExecution
): InstalledEvidenceProof {
  expect(execution.outcome.status).toBe("success");
  const { cacheMessage } = execution;

  if (cacheMessage?.kind !== "inspection-cache-write") {
    throw new Error(
      "Successful analysis did not retain an Installed Evidence Proof."
    );
  }

  return cacheMessage.proof;
};

describe("installed-evidence-proof", () => {
  describe("Installed Evidence Proof replay", () => {
    it.each(["extra", "@types/extra"])(
      "keeps undeclared hoisted %s outside cached resolution",
      async (dependencyName) => {
        const root = await mkdtemp(
          nodePath.join(tmpdir(), "typepeek-proof-undeclared-")
        );

        try {
          const packageRoot = nodePath.join(root, "node_modules", "entry");

          const dependencyRoot = nodePath.join(
            root,
            "node_modules",
            dependencyName
          );

          const manifestPath = nodePath.join(packageRoot, "package.json");

          const manifest = {
            name: "entry",
            types: "index.d.ts",
            version: "1.0.0",
          };

          await mkdir(packageRoot, { recursive: true });
          await mkdir(dependencyRoot, { recursive: true });
          await Promise.all([
            writeFile(
              nodePath.join(root, "package.json"),
              JSON.stringify({ name: "fixture" })
            ),
            writeFile(manifestPath, JSON.stringify(manifest)),
            writeFile(
              nodePath.join(packageRoot, "index.d.ts"),
              'import "extra";\nexport interface Value { fixed: true; }'
            ),
            writeFile(
              nodePath.join(dependencyRoot, "package.json"),
              JSON.stringify({
                name: dependencyName,
                types: "index.d.ts",
                version: "1.0.0",
              })
            ),
            writeFile(
              nodePath.join(dependencyRoot, "index.d.ts"),
              "export interface Extra { value: string; }"
            ),
          ]);

          const request = {
            intent: "member-discovery",
            request: {
              accessStyle: "import",
              exportName: "Value",
              memberPath: [],
              resolutionContext: root,
              specifier: "entry",
            },
          } as const;

          const proof = successfulProof(
            await analyzeInspection(request, false)
          );

          expect(proof.resolutions).toContainEqual(
            match.objectContaining({
              allowedRoots: [],
              kind: "module",
              specifier: "extra",
            })
          );
          await expect(
            installedEvidenceProofStillMatches(
              proof,
              await currentSelectionProof(request.request)
            )
          ).resolves.toBeTruthy();
          await writeFile(
            manifestPath,
            JSON.stringify({ ...manifest, dependencies: { extra: "1.0.0" } })
          );
          await expect(
            installedEvidenceProofStillMatches(
              proof,
              await currentSelectionProof(request.request)
            )
          ).resolves.toBeFalsy();
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      }
    );

    it.each([
      "implicit-module",
      "implicit-type-reference",
      "explicit-mode",
      "no-probe",
      "fixed-extension",
      "new-package-scope",
    ])(
      "rechecks declaration format and manifest scope for %s",
      async (scenario) => {
        const fixtureRoot = await mkdtemp(
          nodePath.join(tmpdir(), "typepeek-proof-source-format-")
        );

        try {
          const root = await realpath(fixtureRoot);
          const packageRoot = nodePath.join(root, "node_modules", "entry");

          const dependencyRoot = nodePath.join(
            root,
            "node_modules",
            "conditional"
          );

          const declarationName =
            scenario === "fixed-extension" ? "index.d.mts" : "index.d.ts";

          const declarationPath = nodePath.join(
            packageRoot,
            "dist",
            "nested",
            declarationName
          );

          const typeReference = scenario === "implicit-type-reference";

          const readDeclaration = (): string => {
            if (typeReference) {
              return '/// <reference types="conditional" />\nexport interface Value extends Selected {}';
            }

            if (scenario === "explicit-mode") {
              return 'export type Value = import("conditional", { with: { "resolution-mode": "require" } }).Value;';
            }

            if (scenario === "no-probe") {
              return "export interface Value { fixedOnly: true }";
            }

            return 'export { Value } from "conditional";';
          };

          const declaration = readDeclaration();

          await Promise.all([
            mkdir(nodePath.join(packageRoot, "dist", "nested"), {
              recursive: true,
            }),
            mkdir(dependencyRoot, { recursive: true }),
          ]);
          await Promise.all([
            writeFile(
              nodePath.join(root, "package.json"),
              JSON.stringify({ name: "fixture" })
            ),
            writeFile(
              nodePath.join(packageRoot, "package.json"),
              JSON.stringify({
                dependencies: { conditional: "1.0.0" },
                name: "entry",
                types: `dist/nested/${declarationName}`,
                version: "1.0.0",
              })
            ),
            writeFile(declarationPath, declaration),
            writeFile(
              nodePath.join(dependencyRoot, "package.json"),
              JSON.stringify({
                exports: Object.fromEntries([
                  ["import", "./import.d.ts"],
                  ["require", "./require.d.ts"],
                ]),
                name: "conditional",
                version: "1.0.0",
              })
            ),
            ...["import", "require"].map(async (mode) => {
              await writeFile(
                nodePath.join(dependencyRoot, `${mode}.d.ts`),
                `${typeReference ? "interface Selected" : "export interface Value"} { ${mode}Only: true }`
              );
            }),
          ]);

          const request = {
            intent: "member-discovery",
            request: {
              accessStyle: "import",
              exportName: "Value",
              memberPath: [],
              resolutionContext: root,
              specifier: "entry",
            },
          } as const;

          const before = await analyzeInspection(request, false);
          const proof = successfulProof(before);

          const readBeforeName = () => {
            if (scenario === "fixed-extension") {
              return "importOnly";
            }

            if (scenario === "no-probe") {
              return "fixedOnly";
            }

            return "requireOnly";
          };

          const beforeName = readBeforeName();

          expect([
            before.outcome,
            proof.files.find(({ path }) => path === declarationPath)
              ?.sourceFormat,
            await installedEvidenceProofStillMatches(
              proof,
              await currentSelectionProof(request.request)
            ),
          ]).toStrictEqual([
            match.objectContaining({
              result: match.objectContaining({
                members: [match.objectContaining({ name: beforeName })],
              }),
              status: "success",
            }),
            {
              accessStyle:
                scenario === "fixed-extension" ? "import" : "require",
              path: declarationPath,
            },
            true,
          ]);

          if (scenario === "no-probe") {
            const signatureProof = successfulProof(
              await analyzeInspection(
                {
                  intent: "signature-inspection",
                  request: {
                    accessStyle: "import",
                    exportName: "Value",
                    resolutionContext: root,
                    specifier: "entry",
                  },
                },
                false
              )
            );

            await assertStandardLibraryProof(
              signatureProof,
              await currentSelectionProof(request.request)
            );
          }

          // A new manifest can change inferred format or the dependency declaration authority.
          await writeFile(
            nodePath.join(packageRoot, "dist", "package.json"),
            JSON.stringify(
              scenario === "new-package-scope"
                ? { name: "inner", version: "1.0.0" }
                : { type: "module" }
            )
          );
          await expect(
            installedEvidenceProofStillMatches(
              proof,
              await currentSelectionProof(request.request)
            )
          ).resolves.toBeFalsy();
          const after = await analyzeInspection(request, false);

          const afterName =
            scenario === "implicit-module" || typeReference
              ? "importOnly"
              : beforeName;

          expect(after.outcome).toMatchObject(
            scenario === "new-package-scope"
              ? { reason: "unsupported-evidence", status: "unsupported" }
              : {
                  result: { members: [{ name: afterName }] },
                  status: "success",
                }
          );

          if (scenario === "new-package-scope") {
            return;
          }

          const afterProof = successfulProof(after);
          await expect(
            installedEvidenceProofStillMatches(
              afterProof,
              await currentSelectionProof(request.request)
            )
          ).resolves.toBeTruthy();

          if (scenario === "explicit-mode") {
            assertExplicitResolutionProof(afterProof, declarationPath);
          }
        } finally {
          await rm(fixtureRoot, { force: true, recursive: true });
        }
      }
    );

    it.each([".pnp.cjs", ".pnp.js", "pnpm-workspace.yaml"])(
      "replays observed absence of %s installation metadata",
      async (marker) => {
        const fixtureRoot = await mkdtemp(
          nodePath.join(tmpdir(), "typepeek-proof-installation-marker-")
        );

        try {
          const root = await realpath(fixtureRoot);
          const packageRoot = nodePath.join(root, "node_modules", "entry");

          const dependencyRoot = nodePath.join(
            root,
            "node_modules",
            "dependency"
          );

          await mkdir(nodePath.join(packageRoot, "dist"), { recursive: true });
          await mkdir(dependencyRoot, { recursive: true });
          await Promise.all([
            writeFile(
              nodePath.join(root, "package.json"),
              JSON.stringify({ name: "fixture" })
            ),
            writeFile(
              nodePath.join(packageRoot, "package.json"),
              JSON.stringify({
                dependencies: { dependency: "1.0.0" },
                name: "entry",
                types: "dist/index.d.ts",
                version: "1.0.0",
              })
            ),
            writeFile(
              nodePath.join(packageRoot, "dist", "index.d.ts"),
              'export { Value } from "dependency";'
            ),
            writeFile(
              nodePath.join(dependencyRoot, "package.json"),
              JSON.stringify({
                name: "dependency",
                types: "index.d.ts",
                version: "1.0.0",
              })
            ),
            writeFile(
              nodePath.join(dependencyRoot, "index.d.ts"),
              "export interface Value { value: string }"
            ),
          ]);

          const request = {
            intent: "member-discovery",
            request: {
              accessStyle: "import",
              exportName: "Value",
              memberPath: [],
              resolutionContext: root,
              specifier: "entry",
            },
          } as const;

          const proof = successfulProof(
            await analyzeInspection(request, false)
          );

          const markerPath = nodePath.join(
            packageRoot,
            ...(marker === "pnpm-workspace.yaml" ? [] : ["dist"]),
            marker
          );

          expect(proof.fileChecks).toContainEqual({
            exists: false,
            path: markerPath,
          });
          await expect(
            installedEvidenceProofStillMatches(proof, proof)
          ).resolves.toBeTruthy();
          await writeFile(markerPath, "");
          await expect(
            installedEvidenceProofStillMatches(proof, proof)
          ).resolves.toBeFalsy();

          if (marker !== "pnpm-workspace.yaml") {
            assertUnsupportedAnalysis(await analyzeInspection(request, false));
          }
        } finally {
          await rm(fixtureRoot, { force: true, recursive: true });
        }
      }
    );

    it("rejects a retargeted manifest symlink that changes dependency authority", async () => {
      const fixtureRoot = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-proof-manifest-symlink-")
      );

      try {
        const root = await realpath(fixtureRoot);
        const packageRoot = nodePath.join(root, "node_modules", "entry");

        const dependencyRoot = nodePath.join(
          root,
          "node_modules",
          "dependency"
        );

        const scopePath = nodePath.join(packageRoot, "dist", "package.json");
        const oldTarget = nodePath.join(packageRoot, "config", "old.json");
        const newTarget = nodePath.join(packageRoot, "config", "new.json");
        await Promise.all([
          mkdir(nodePath.join(packageRoot, "dist"), { recursive: true }),
          mkdir(nodePath.join(packageRoot, "config"), { recursive: true }),
          mkdir(dependencyRoot, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            nodePath.join(root, "package.json"),
            JSON.stringify({ name: "fixture" })
          ),
          writeFile(
            nodePath.join(packageRoot, "package.json"),
            JSON.stringify({
              dependencies: { dependency: "1.0.0" },
              name: "entry",
              types: "dist/index.d.ts",
              version: "1.0.0",
            })
          ),
          writeFile(
            nodePath.join(packageRoot, "dist", "index.d.ts"),
            'export { Value } from "dependency";'
          ),
          writeFile(
            nodePath.join(dependencyRoot, "package.json"),
            JSON.stringify({
              name: "dependency",
              types: "index.d.ts",
              version: "1.0.0",
            })
          ),
          writeFile(
            nodePath.join(dependencyRoot, "index.d.ts"),
            "export interface Value { value: string }"
          ),
          writeFile(
            oldTarget,
            JSON.stringify({
              dependencies: { dependency: "1.0.0" },
              name: "inner",
              version: "1.0.0",
            })
          ),
          writeFile(
            newTarget,
            JSON.stringify({ name: "inner", version: "1.0.0" })
          ),
        ]);
        await symlink(oldTarget, scopePath);

        const request = {
          intent: "member-discovery",
          request: {
            accessStyle: "import",
            exportName: "Value",
            memberPath: [],
            resolutionContext: root,
            specifier: "entry",
          },
        } as const;

        const proof = successfulProof(await analyzeInspection(request, false));
        expect(proof.fileChecks).toContainEqual({
          canonicalPath: oldTarget,
          exists: true,
          path: scopePath,
        });
        await expect(
          installedEvidenceProofStillMatches(
            proof,
            await currentSelectionProof(request.request)
          )
        ).resolves.toBeTruthy();
        await unlink(scopePath);
        await symlink(newTarget, scopePath);
        const analyzeInspectionResult = await analyzeInspection(request, false);
        expect([
          analyzeInspectionResult.outcome,
          await installedEvidenceProofStillMatches(
            proof,
            await currentSelectionProof(request.request)
          ),
        ]).toStrictEqual([
          match.objectContaining({
            reason: "unsupported-evidence",
            status: "unsupported",
          }),
          false,
        ]);
      } finally {
        await rm(fixtureRoot, { force: true, recursive: true });
      }
    });

    it("bounds unique file checks and disables contradictory receipts", () => {
      const recorder = createInstalledEvidenceFingerprintRecorder();

      for (
        let index = 0;
        index < EVIDENCE_PROOF_LIMITS.fileChecks;
        index += 1
      ) {
        const path = nodePath.join(
          tmpdir(),
          "typepeek-presence-budget",
          String(index)
        );

        recorder.observeFilePresence(path, false);
        recorder.observeFilePresence(path, false);
      }

      expect(recorder.snapshot()?.fileChecks).toHaveLength(
        EVIDENCE_PROOF_LIMITS.fileChecks
      );
      recorder.observeFilePresence(
        nodePath.join(tmpdir(), "typepeek-presence-budget", "overflow"),
        false
      );
      expect(recorder.snapshot()).toBeUndefined();
      const conflicting = createInstalledEvidenceFingerprintRecorder();
      const path = nodePath.join(tmpdir(), "typepeek-presence-conflict");
      conflicting.observeFilePresence(path, false);
      conflicting.observeFilePresence(path, true);
      expect(conflicting.snapshot()).toBeUndefined();
    });

    it("replays format through a proved logical package root and rejects conflicting observations", async () => {
      const fixtureRoot = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-proof-logical-format-")
      );

      try {
        const root = await realpath(fixtureRoot);
        const packageRoot = nodePath.join(root, "workspace-package");
        const logicalRoot = nodePath.join(root, "node_modules", "linked");
        await mkdir(nodePath.join(packageRoot, "dist"), { recursive: true });
        await mkdir(nodePath.join(root, "node_modules"), { recursive: true });
        await symlink(
          packageRoot,
          logicalRoot,
          process.platform === "win32" ? "junction" : "dir"
        );

        const manifest = JSON.stringify({
          name: "linked",
          types: "dist/index.d.ts",
          version: "1.0.0",
        });

        const declaration = "export declare const value: 1;";

        const declarationPath = nodePath.join(
          packageRoot,
          "dist",
          "index.d.ts"
        );

        const logicalPath = nodePath.join(logicalRoot, "dist", "index.d.ts");
        await writeFile(nodePath.join(packageRoot, "package.json"), manifest);
        await writeFile(declarationPath, declaration);
        const recorder = createInstalledEvidenceFingerprintRecorder();
        recorder.observeFile(
          nodePath.join(packageRoot, "package.json"),
          manifest,
          "manifest"
        );
        recorder.observeFile(declarationPath, declaration, "declaration", {
          accessStyle: "require",
          path: logicalPath,
        });
        recorder.observeResolution({
          accessStyle: "import",
          allowedRoots: [logicalRoot],
          containingFile: nodePath.join(root, "consumer.mts"),
          kind: "module",
          resolvedPath: declarationPath,
          specifier: "linked",
        });
        const proof = requireDefined(recorder.snapshot());
        await expect(
          installedEvidenceProofStillMatches(proof, proof)
        ).resolves.toBeTruthy();
        await writeFile(
          nodePath.join(packageRoot, "dist", "package.json"),
          JSON.stringify({ type: "module" })
        );
        await expect(
          installedEvidenceProofStillMatches(proof, proof)
        ).resolves.toBeFalsy();
        recorder.observeFile(declarationPath, declaration, "declaration", {
          accessStyle: "import",
          path: declarationPath,
        });
        expect(recorder.snapshot()).toBeUndefined();
      } finally {
        await rm(fixtureRoot, { force: true, recursive: true });
      }
    });

    it.each(["module", "type-reference"] as const)(
      "preserves import and require conditions within one %s proof",
      async (kind) => {
        const fixtureRoot = await mkdtemp(
          nodePath.join(tmpdir(), "typepeek-proof-conditions-")
        );

        try {
          const root = await realpath(fixtureRoot);
          const packageRoot = nodePath.join(root, "node_modules", "dual");
          await mkdir(packageRoot, { recursive: true });
          const recorder = createInstalledEvidenceFingerprintRecorder();
          const manifestPath = nodePath.join(packageRoot, "package.json");

          const manifest = JSON.stringify({
            exports: Object.fromEntries([
              ["import", "./index.d.mts"],
              ["require", "./index.d.cts"],
            ]),
            name: "dual",
          });

          await writeFile(manifestPath, manifest);
          recorder.observeFile(manifestPath, manifest, "manifest");

          await Array.fromAsync(
            ["import", "require"] as const,
            async (accessStyle) => {
              const declarationPath = nodePath.join(
                packageRoot,
                accessStyle === "import" ? "index.d.mts" : "index.d.cts"
              );

              const declaration = `export declare const mode: "${accessStyle}";`;
              await writeFile(declarationPath, declaration);
              recorder.observeFile(declarationPath, declaration, "declaration");
              recorder.observeResolution({
                accessStyle,
                allowedRoots: [packageRoot],
                containingFile: nodePath.join(root, "consumer.ts"),
                kind,
                resolvedPath: declarationPath,
                specifier: "dual",
              });
            }
          );

          const proof = requireDefined(recorder.snapshot());
          expect([
            await installedEvidenceProofStillMatches(proof, proof),
            await installedEvidenceProofStillMatches(
              { ...proof, resolutions: [...proof.resolutions].toReversed() },
              proof
            ),
          ]).toStrictEqual([true, true]);
        } finally {
          await rm(fixtureRoot, { force: true, recursive: true });
        }
      }
    );

    it.each(["relative", "package"])(
      "separates root permissions and refreshes missing %s declarations between replays",
      async (resolution) => {
        const fixtureRoot = await mkdtemp(
          nodePath.join(tmpdir(), "typepeek-proof-capabilities-")
        );

        try {
          const root = await realpath(fixtureRoot);
          const recorder = createInstalledEvidenceFingerprintRecorder();
          const manifestPath = nodePath.join(root, "package.json");

          const manifest = JSON.stringify({
            dependencies: { "future-package": "1.0.0" },
            name: "local-evidence",
            type: "module",
          });

          await writeFile(manifestPath, manifest);
          recorder.observeFile(manifestPath, manifest, "manifest");
          const declarationPath = nodePath.join(root, "present.d.ts");
          await writeFile(declarationPath, "export declare const value: 1;");
          const containingFile = nodePath.join(root, "consumer.mts");

          for (const allowed of [true, false]) {
            recorder.observeResolution({
              allowedRoots: allowed ? [root] : [],
              containingFile,
              kind: "module",
              ...(allowed && { resolvedPath: declarationPath }),
              specifier: "./present.js",
            });
          }

          recorder.observeResolution({
            allowedRoots: resolution === "relative" ? [root] : [],
            containingFile,
            kind: "module",
            specifier:
              resolution === "relative" ? "./future.js" : "future-package",
          });
          const proof = requireDefined(recorder.snapshot());
          expect([
            await installedEvidenceProofStillMatches(proof, proof),
            await installedEvidenceProofStillMatches(
              { ...proof, resolutions: [...proof.resolutions].toReversed() },
              proof
            ),
          ]).toStrictEqual([true, true]);

          const dependencyRoot = nodePath.join(
            root,
            "node_modules",
            "future-package"
          );

          if (resolution === "package") {
            await mkdir(dependencyRoot, { recursive: true });
            await writeFile(
              nodePath.join(dependencyRoot, "package.json"),
              JSON.stringify({
                name: "future-package",
                types: "index.d.ts",
                version: "1.0.0",
              })
            );
          }

          await writeFile(
            resolution === "relative"
              ? nodePath.join(root, "future.d.ts")
              : nodePath.join(dependencyRoot, "index.d.ts"),
            "export declare const value: 2;"
          );
          await expect(
            installedEvidenceProofStillMatches(proof, proof)
          ).resolves.toBeFalsy();
        } finally {
          await rm(fixtureRoot, { force: true, recursive: true });
        }
      }
    );

    it("accepts unchanged evidence and rejects changed evidence through one interface", async () => {
      const fixtureRoot = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-proof-replay-")
      );

      try {
        const evidencePath = nodePath.join(
          await realpath(fixtureRoot),
          "index.d.ts"
        );

        const original = "export declare const value: 1;\n";
        await writeFile(evidencePath, original);
        const recorder = createInstalledEvidenceFingerprintRecorder();
        recorder.observeFile(evidencePath, original, "declaration");
        const proof = recorder.snapshot();
        expect(proof).toBeDefined();

        if (proof === undefined) {
          return;
        }

        await expect(
          installedEvidenceProofStillMatches(proof, proof)
        ).resolves.toBeTruthy();
        await writeFile(evidencePath, "export declare const value: 2;\n");
        await expect(
          installedEvidenceProofStillMatches(proof, proof)
        ).resolves.toBeFalsy();
      } finally {
        await rm(fixtureRoot, { force: true, recursive: true });
      }
    });
  });
});
