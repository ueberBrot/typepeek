import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { canonicalEvidenceCandidatePath } from "#typepeek/inspection/evidence-boundary";
import {
  materializeInspectableModuleEvidence,
  selectInspectableModule,
} from "#typepeek/inspection/installed-evidence";
import {
  createInstalledEvidenceFingerprintRecorder,
  MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import { compactEvidenceProof } from "#typepeek/inspection/installed-evidence-format";
import { readDeclarationProvenance } from "#typepeek/inspection/installed-package-boundary";

describe("compiler work session", () => {
  it("applies the manifest limit before the aggregate allowance unless fewer bytes remain", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-resolution-manifest-budget-")
    );

    try {
      const manifestPath = nodePath.join(fixtureRoot, "package.json");
      const maximumManifestBytes = 256 * 1024;
      const exactManifest = " ".repeat(maximumManifestBytes);
      await writeFile(manifestPath, exactManifest);
      expect(createCompilerWorkSession().readResolutionFile(manifestPath)).toBe(
        exactManifest
      );
      await writeFile(manifestPath, `${exactManifest} `);
      expect(() =>
        createCompilerWorkSession().readResolutionFile(manifestPath)
      ).toThrow("Inspection exceeded its package manifest size limit.");
      expect(() =>
        createCompilerWorkSession({
          resolutionBytes: maximumManifestBytes - 1,
        }).readResolutionFile(manifestPath)
      ).toThrow("Inspection exceeded its compiler host byte limit.");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("bounds nested format manifests consumed while materializing declaration evidence", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-nested-manifest-budget-")
    );

    try {
      const resolutionContext = await realpath(fixtureRoot);

      const packageRoot = nodePath.join(
        resolutionContext,
        "node_modules",
        "bounded-package"
      );

      await mkdir(nodePath.join(packageRoot, "nested"), { recursive: true });
      await Promise.all([
        writeFile(
          nodePath.join(resolutionContext, "package.json"),
          JSON.stringify({
            dependencies: { "bounded-package": "1.0.0" },
            name: "fixture",
          })
        ),
        writeFile(
          nodePath.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "bounded-package",
            types: "index.d.ts",
            version: "1.0.0",
          })
        ),
        writeFile(
          nodePath.join(packageRoot, "index.d.ts"),
          'export { Value } from "./nested/value.js";'
        ),
        writeFile(
          nodePath.join(packageRoot, "nested", "value.d.ts"),
          "export interface Value { value: string }"
        ),
        writeFile(
          nodePath.join(packageRoot, "nested", "package.json"),
          JSON.stringify({ padding: "x".repeat(256 * 1024), type: "module" })
        ),
      ]);

      const selection = selectInspectableModule({
        accessStyle: "import",
        resolutionContext,
        specifier: "bounded-package",
      });

      expect(selection).toBeDefined();
      expect(() =>
        materializeInspectableModuleEvidence(requireDefined(selection), [
          { intent: "interface-overview" },
        ])
      ).toThrow("Inspection exceeded its package manifest size limit.");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("charges declaration ownership checks to the shared compiler budget", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-provenance-budget-")
    );

    try {
      const repositoryRoot = await realpath(fixtureRoot);

      const packageRoot = nodePath.join(
        repositoryRoot,
        "node_modules",
        "bounded-package"
      );

      const declarationPath = nodePath.join(packageRoot, "index.d.ts");
      const packageIdentity = { name: "bounded-package", version: "1.0.0" };
      await mkdir(packageRoot, { recursive: true });
      await Promise.all([
        writeFile(
          nodePath.join(packageRoot, "package.json"),
          JSON.stringify(packageIdentity)
        ),
        writeFile(declarationPath, "export declare const value: 1;\n"),
      ]);
      const session = createCompilerWorkSession({ operations: 3 });

      const readProvenance = () =>
        readDeclarationProvenance(
          repositoryRoot,
          packageRoot,
          packageIdentity,
          declarationPath,
          session.packageBoundaryObserver
        );

      expect(readProvenance()).toStrictEqual({
        file: "node_modules/bounded-package/index.d.ts",
        packageIdentity,
      });
      expect(readProvenance).toThrow(
        "Inspection exceeded its compiler host work limit."
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("stops recording filesystem evidence once the proof cannot fit its byte budget", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-proof-recording-budget-")
    );

    try {
      const containingFile = nodePath.join(
        await realpath(fixtureRoot),
        "index.d.ts"
      );

      const recorder = createInstalledEvidenceFingerprintRecorder();

      for (let index = 0; index < 3000; index += 1) {
        recorder.observeResolution({
          allowedRoots: [],
          containingFile,
          kind: "module",
          specifier: `${index}-${"x".repeat(3000)}`,
        });
      }

      expect(recorder.snapshot()).toBeUndefined();
      expect(() => {
        recorder.observeResolution({
          allowedRoots: [],
          get containingFile(): string {
            throw new Error(
              "Uncacheable evidence must not trigger another filesystem probe."
            );
          },
          kind: "module",
          specifier: "next",
        });
      }).not.toThrow();
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("retains the exact proof byte limit without charging duplicate observations", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-proof-exact-budget-")
    );

    try {
      const containingFile = nodePath.join(
        await realpath(fixtureRoot),
        "index.d.ts"
      );

      await writeFile(containingFile, "export type Value = string;");
      const recorder = createInstalledEvidenceFingerprintRecorder();
      const entries = await readdir(fixtureRoot, { withFileTypes: true });

      for (let repetition = 0; repetition < 2; repetition += 1) {
        recorder.observeFile(
          containingFile,
          "export type Value = string;",
          "declaration"
        );
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
        const before = requireDefined(recorder.snapshot());
        const next = probe(`${nextIndex}-${"🌍".repeat(600)}`);

        if (
          Buffer.byteLength(
            JSON.stringify(
              compactEvidenceProof({
                ...before,
                resolutions: [...before.resolutions, next],
              })
            )
          ) > MAX_INSTALLED_EVIDENCE_PROOF_BYTES
        ) {
          break;
        }

        recorder.observeResolution(next);
        recorder.observeResolution(next);
        nextIndex += 1;
      }

      const before = requireDefined(recorder.snapshot());

      const withEmpty = {
        ...before,
        resolutions: [...before.resolutions, probe("")],
      };

      const remaining =
        MAX_INSTALLED_EVIDENCE_PROOF_BYTES -
        Buffer.byteLength(JSON.stringify(compactEvidenceProof(withEmpty)));

      const finalProbe = probe("z".repeat(remaining));
      recorder.observeResolution(finalProbe);
      recorder.observeResolution(finalProbe);
      expect(
        Buffer.byteLength(
          JSON.stringify(
            compactEvidenceProof(requireDefined(recorder.snapshot()))
          )
        )
      ).toBe(MAX_INSTALLED_EVIDENCE_PROOF_BYTES);
      recorder.observeResolution(probe("overflow"));
      expect(recorder.snapshot()).toBeUndefined();
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("retains unresolved probes with no filesystem capability", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-empty-resolution-capability-")
    );

    try {
      const containingFile = nodePath.join(
        await realpath(fixtureRoot),
        "index.d.ts"
      );

      const recorder = createInstalledEvidenceFingerprintRecorder();
      recorder.observeResolution({
        allowedRoots: [],
        containingFile,
        kind: "module",
        specifier: "node:missing",
      });
      expect(recorder.snapshot()).toStrictEqual({
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
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("bounds missing-path canonicalization depth", () => {
    const deeplyMissingPath = nodePath.join(
      tmpdir(),
      ...Array.from({ length: 300 }, (_, index) => `missing-${index}`)
    );

    expect(() => canonicalEvidenceCandidatePath(deeplyMissingPath)).toThrow(
      "Inspection exceeded its compiler host work limit."
    );
  });

  it("allows the exact aggregate limits and rejects the next work", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-compiler-session-")
    );

    try {
      const firstFile = nodePath.join(fixtureRoot, "first.txt");
      const secondFile = nodePath.join(fixtureRoot, "second.txt");
      const overflowFile = nodePath.join(fixtureRoot, "overflow.txt");
      await Promise.all([
        writeFile(firstFile, "12"),
        writeFile(secondFile, "34"),
        writeFile(overflowFile, "5"),
      ]);
      const byteSession = createCompilerWorkSession({ resolutionBytes: 4 });
      expect([
        byteSession.readResolutionFile(firstFile),
        byteSession.readResolutionFile(secondFile),
      ]).toStrictEqual(["12", "34"]);
      expect(() => byteSession.readResolutionFile(overflowFile)).toThrow(
        "Inspection exceeded its compiler host byte limit."
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }

    const operationSession = createCompilerWorkSession({ operations: 2 });
    operationSession.reserveOperations();
    operationSession.reserveOperations();
    expect(() => {
      operationSession.reserveOperations();
    }).toThrow("Inspection exceeded its compiler host work limit.");
  });

  it("preserves UTF-8 across large reads and rejects the first byte beyond the budget", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-chunked-evidence-")
    );

    try {
      const fileName = nodePath.join(fixtureRoot, "declaration.txt");
      const text = `${"x".repeat(65_535)}🌍${"y".repeat(65_535)}`;
      await writeFile(fileName, text);
      const bytes = Buffer.byteLength(text);
      expect(
        createCompilerWorkSession({
          resolutionBytes: bytes,
        }).readResolutionFile(fileName)
      ).toBe(text);
      expect(() =>
        createCompilerWorkSession({
          resolutionBytes: bytes - 1,
        }).readResolutionFile(fileName)
      ).toThrow("Inspection exceeded its compiler host byte limit.");
      await writeFile(fileName, "");
      expect(
        createCompilerWorkSession({ resolutionBytes: 0 }).readResolutionFile(
          fileName
        )
      ).toBe("");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("bounds package resolution before it can return authoritative evidence", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-resolution-budget-")
    );

    const packageRoot = nodePath.join(
      fixtureRoot,
      "node_modules",
      "bounded-package"
    );

    try {
      await mkdir(nodePath.join(packageRoot, "dist"), { recursive: true });

      const manifest = {
        name: "bounded-package",
        types: "./dist/index.d.ts",
        version: "1.0.0",
      };

      await Promise.all([
        writeFile(
          nodePath.join(packageRoot, "package.json"),
          JSON.stringify(manifest)
        ),
        writeFile(
          nodePath.join(packageRoot, "dist", "index.d.ts"),
          "export declare const value: 1;\n"
        ),
      ]);
      const session = createCompilerWorkSession({ resolutionBytes: 8 });

      const resolver = session.createPackageResolver(fixtureRoot, "import", [
        packageRoot,
      ]);

      expect(() => resolver.resolve("bounded-package")).toThrow(
        "Inspection exceeded its compiler host byte limit."
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("resolves only through explicitly allowed declaration roots", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-resolution-authority-")
    );

    const contextRoot = nodePath.join(fixtureRoot, "workspace", "project");

    const allowedRoot = nodePath.join(
      fixtureRoot,
      "node_modules",
      "bounded-package"
    );

    const nearerRoot = nodePath.join(
      contextRoot,
      "node_modules",
      "bounded-package"
    );

    try {
      await Promise.all([
        mkdir(nodePath.join(allowedRoot, "dist"), { recursive: true }),
        mkdir(nodePath.join(nearerRoot, "dist"), { recursive: true }),
      ]);

      const manifest = JSON.stringify({
        name: "bounded-package",
        types: "./dist/index.d.ts",
        version: "1.0.0",
      });

      await Promise.all([
        writeFile(nodePath.join(allowedRoot, "package.json"), manifest),
        writeFile(
          nodePath.join(allowedRoot, "dist", "index.d.ts"),
          "export declare const allowed: 1;\n"
        ),
        writeFile(nodePath.join(nearerRoot, "package.json"), manifest),
        writeFile(
          nodePath.join(nearerRoot, "dist", "index.d.ts"),
          "export declare const nearer: 1;\n"
        ),
      ]);

      const resolver = createCompilerWorkSession().createPackageResolver(
        contextRoot,
        "import",
        [allowedRoot]
      );

      expect([
        resolver.resolve("bounded-package"),
        createCompilerWorkSession().resolveEvidenceProbe(
          {
            accessStyle: "import",
            containingFile: nodePath.join(contextRoot, "index.mts"),
            kind: "module",
            specifier: "bounded-package",
          },
          [contextRoot, allowedRoot]
        ),
      ]).toStrictEqual([
        await realpath(nodePath.join(allowedRoot, "dist", "index.d.ts")),
        await realpath(nodePath.join(allowedRoot, "dist", "index.d.ts")),
      ]);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
