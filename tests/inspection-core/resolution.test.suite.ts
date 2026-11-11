import { access } from "node:fs/promises";
import nodePath from "node:path";

import { expect, test } from "vite-plus/test";

import {
  inspectExport,
  inspectExportSignatures,
  inspectInterfaceOverview,
} from "#typepeek/inspection";
import { runCommand } from "#typepeek/platform/process-command";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerResolutionTests = function registerResolutionTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("fails explicitly before an oversized request crosses the analysis process seam", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "x".repeat(17 * 1024),
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "request-bytes",
      message: "Inspection exceeded its request input limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("describes a compiled Package Module without executing its runtime", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/compiled",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect([
      outcome.result.packageIdentity,
      outcome.result.moduleExports.map(({ name }) => name),
    ]).toStrictEqual([
      {
        name: "@typepeek-fixture/compiled",
        version: "1.2.3",
      },
      [
        "VERSION",
        "WidgetOptions",
        "createWidget",
        "default",
        "dependencyExport",
      ],
    ]);
    await expect(access(getFixture().runtimeSentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("inspects an npm-hoisted Package Module from a workspace Resolution Context", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: nodePath.join(
        getFixture().resolutionContext,
        "packages",
        "workspace-main"
      ),
      specifier: "@typepeek-fixture/dependency",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "dependencyExport" }],
        packageIdentity: {
          name: "@typepeek-fixture/dependency",
          version: "1.0.0",
        },
      },
      status: "success",
    });
  });

  test("renders an Interface Overview through the CLI", async () => {
    const result = await runCommand(process.execPath, [
      "src/cli.ts",
      "@typepeek-fixture/compiled",
      "--workspace",
      getFixture().resolutionContext,
    ]);

    expect(result.stdout).toBe(
      [
        "Interface Overview",
        "Specifier: @typepeek-fixture/compiled",
        "Access Style: import",
        "Package: @typepeek-fixture/compiled@1.2.3",
        "Module Exports (5):",
        "- VERSION",
        "- WidgetOptions",
        "- createWidget",
        "- default",
        "- dependencyExport",
        "Public Subpaths (0; use --subpaths to list):",
      ].join("\n")
    );
    await expect(access(getFixture().runtimeSentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);

  test("reports a limit instead of truncating a broad Module Export index", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad",
    });

    expect(outcome).toMatchObject({
      exceededBudget: "module-exports",
      message: "Inspection exceeded its Module Export limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("reports a limit instead of truncating broad Public Subpath evidence", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-subpaths",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "public-subpaths",
      message: "Inspection exceeded its Public Subpath limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("reuses bounded compiler evidence across the maximum Public Subpath set", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/bounded-subpaths",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect([
      outcome.result.publicSubpaths.length,
      outcome.result.publicSubpaths.at(0),
      outcome.result.publicSubpaths.at(-1),
    ]).toStrictEqual([
      512,
      {
        specifier: "@typepeek-fixture/bounded-subpaths/feature-0",
      },
      {
        specifier: "@typepeek-fixture/bounded-subpaths/feature-99",
      },
    ]);
  });

  test("does not enumerate Public Subpaths for a focused root Export Inspection", async () => {
    const outcome = await inspectExport({
      exportName: "rootExport",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-subpaths",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExport: {
          name: "rootExport",
        },
      },
      status: "success",
    });
  });

  test("reports a limit for deeply nested package export targets", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/deep-export-target",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "package-export-targets",
      message: "Inspection exceeded its package export target traversal limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("ignores deeply nested targets from an unselected Access Style", async () => {
    const outcome = await inspectInterfaceOverview({
      accessStyle: "import",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/conditional-poison",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "importRootExport" }],
        publicSubpaths: [
          { specifier: "@typepeek-fixture/conditional-poison/array/red" },
          {
            specifier:
              "@typepeek-fixture/conditional-poison/condition-fallback/red",
          },
          { specifier: "@typepeek-fixture/conditional-poison/patterns/red" },
          { specifier: "@typepeek-fixture/conditional-poison/versioned/red" },
        ],
      },
      status: "success",
    });
  });

  test("bounds one broad Public Subpath directory before materializing every entry", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-pattern-files",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "public-subpath-files",
      message: "Inspection exceeded its Public Subpath file traversal limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("does not traverse a Public Subpath search-root symlink outside its package", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/symlink-subpath",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "rootExport" }],
        publicSubpaths: [],
      },
      status: "success",
    });
  });

  test("preserves logical Public Subpaths through package-internal symlinks", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/internal-symlink-subpath",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "rootExport" }],
        publicSubpaths: [
          {
            specifier:
              "@typepeek-fixture/internal-symlink-subpath/nested-link/patterns/red",
          },
          {
            specifier:
              "@typepeek-fixture/internal-symlink-subpath/root-link/red",
          },
        ],
      },
      status: "success",
    });
  });

  test("rejects an unresolved declaration re-export instead of returning a partial index", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/unresolved",
    });

    expect(outcome).toMatchObject({
      message:
        "A declaration re-export could not be resolved from Installed Evidence.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  test("rejects a physically hoisted re-export not declared by its Package Module", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/undeclared-reexport",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration re-export could not be resolved from Installed Evidence.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  test("follows installed workspace links across Package Module boundaries", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/workspace-main",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "workspaceDependencyExport" }],
      },
      status: "success",
    });
  });

  test("selects the declaration Resolution Variant for the requested Access Style", async () => {
    const [importOutcome, requireOutcome] = await Promise.all([
      inspectInterfaceOverview({
        accessStyle: "import",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/conditional",
      }),
      inspectInterfaceOverview({
        accessStyle: "require",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/conditional",
      }),
    ]);

    expect([importOutcome.status, requireOutcome.status]).toStrictEqual([
      "success",
      "success",
    ]);

    if (
      importOutcome.status !== "success" ||
      requireOutcome.status !== "success"
    ) {
      return;
    }

    expect([
      {
        moduleExports: importOutcome.result.moduleExports.map(
          ({ name }) => name
        ),
        resolutionVariant: importOutcome.result.resolutionVariant,
      },
      {
        moduleExports: requireOutcome.result.moduleExports.map(
          ({ name }) => name
        ),
        resolutionVariant: requireOutcome.result.resolutionVariant,
      },
    ]).toStrictEqual([
      {
        moduleExports: ["importExport"],
        resolutionVariant: { accessStyle: "import" },
      },
      {
        moduleExports: ["requireExport"],
        resolutionVariant: { accessStyle: "require" },
      },
    ]);
  });

  test("advertises manifest-declared Public Subpaths without inspecting them", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/conditional",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "importExport" }],
        publicSubpaths: [
          { specifier: "@typepeek-fixture/conditional/feature" },
          { specifier: "@typepeek-fixture/conditional/nested/feature" },
          { specifier: "@typepeek-fixture/conditional/patterns/red" },
        ],
      },
      status: "success",
    });
  });

  test("advertises only Public Subpaths available to the selected Access Style", async () => {
    const outcome = await inspectInterfaceOverview({
      accessStyle: "require",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/conditional",
    });

    expect(outcome).toMatchObject({
      result: {
        publicSubpaths: [
          { specifier: "@typepeek-fixture/conditional/feature" },
          { specifier: "@typepeek-fixture/conditional/nested/feature" },
          { specifier: "@typepeek-fixture/conditional/patterns/red" },
          { specifier: "@typepeek-fixture/conditional/require-feature" },
          { specifier: "@typepeek-fixture/conditional/require-patterns/blue" },
        ],
      },
      status: "success",
    });
  });

  test("inspects an exact Specifier matched by a Public Subpath pattern", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/conditional/patterns/red",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExports: [{ name: "redPatternExport" }],
        packageIdentity: {
          name: "@typepeek-fixture/conditional",
          version: "1.0.0",
        },
        publicSubpaths: [],
        specifier: "@typepeek-fixture/conditional/patterns/red",
      },
      status: "success",
    });
  });

  test("preserves one Specifier, Resolution Variant, and Package Identity across all Inspection Core intents", async () => {
    const [overview, focused, signatures] = await Promise.all([
      inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/conditional/feature",
      }),
      inspectExport({
        exportName: "featureExport",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/conditional/feature",
      }),
      inspectExportSignatures({
        exportName: "featureExport",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/conditional/feature",
      }),
    ]);

    const successfulOutcomes = [overview, focused, signatures].filter(
      (outcome) => outcome.status === "success"
    );

    expect([
      successfulOutcomes.length,
      successfulOutcomes.map(({ result }) => ({
        packageIdentity: result.packageIdentity,
        resolutionVariant: result.resolutionVariant,
        specifier: result.specifier,
      })),
      overview,
      focused,
    ]).toStrictEqual([
      3,
      Array.from({ length: 3 }, () => ({
        packageIdentity: {
          name: "@typepeek-fixture/conditional",
          version: "1.0.0",
        },
        resolutionVariant: { accessStyle: "import" },
        specifier: "@typepeek-fixture/conditional/feature",
      })),
      match.objectContaining({
        result: match.objectContaining({
          moduleExports: [match.objectContaining({ name: "featureExport" })],
          packageIdentity: match.objectContaining({
            name: "@typepeek-fixture/conditional",
            version: "1.0.0",
          }),
          publicSubpaths: [],
          specifier: "@typepeek-fixture/conditional/feature",
        }),
        status: "success",
      }),
      match.objectContaining({
        result: match.objectContaining({
          moduleExport: match.objectContaining({
            name: "featureExport",
            spaces: [
              match.objectContaining({
                declarations: [
                  match.objectContaining({
                    provenance: match.objectContaining({
                      file: "node_modules/@typepeek-fixture/conditional/dist/feature.d.ts",
                    }),
                  }),
                ],
              }),
            ],
          }),
          packageIdentity: match.objectContaining({
            name: "@typepeek-fixture/conditional",
            version: "1.0.0",
          }),
          specifier: "@typepeek-fixture/conditional/feature",
        }),
        status: "success",
      }),
    ]);
  });

  test("rejects an installed declaration file that is not a Public Subpath", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/conditional/private",
    });

    expect(outcome).toStrictEqual({
      message:
        "The requested Specifier is not a manifest-declared Public Subpath.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });
};
