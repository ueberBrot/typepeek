import { expect, test } from "vite-plus/test";

import { inspectExport } from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerExportAliasTests = function registerExportAliasTests(
  getFixture: () => CompiledPackageFixture
): void {
  test.each(["default", "ToolAlias", "tools"])(
    "inspects the %s alias declaration form",
    async (exportName) => {
      const outcome = await inspectExport({
        exportName,
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/alias-forms",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExport.name,
        outcome.result.moduleExport.alias?.declaration,
      ]).toStrictEqual([
        exportName,
        match.objectContaining({
          kind: "alias",
          provenance: match.objectContaining({
            file: "node_modules/@typepeek-fixture/alias-forms/dist/index.d.ts",
            packageIdentity: match.objectContaining({
              name: "@typepeek-fixture/alias-forms",
              version: "1.0.0",
            }),
          }),
        }),
      ]);

      const aliasExpectations = new Map<string, object>([
        [
          "ToolAlias",
          {
            moduleExport: {
              alias: {
                declaration: {
                  text: match.stringContaining(
                    "import ToolAlias = Internal.ToolAlias"
                  ),
                },
              },
            },
          },
        ],
        [
          "tools",
          {
            moduleExport: { alias: { targetName: "./tools.js" } },
            supportingTypes: match.arrayContaining([
              match.objectContaining({ name: "ToolInput" }),
              match.objectContaining({ name: "NestedInput" }),
            ]),
          },
        ],
      ]);

      expect(outcome.result).toMatchObject(
        aliasExpectations.get(exportName) ?? {}
      );
      expect(
        outcome.result.moduleExport.alias?.targetName?.includes(
          getFixture().resolutionContext
        ) ?? false
      ).toBeFalsy();
    },
    15_000
  );

  test("preserves compiler source order for signatures declared across files", async () => {
    const outcome = await inspectExport({
      exportName: "ordered",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/cross-file-signatures",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.moduleExport.signatures.map(({ kind }) => kind)
    ).toStrictEqual(["construct", "call"]);
  });

  test("rejects circular aliases instead of returning an unknown target", async () => {
    const outcome = await inspectExport({
      exportName: "A",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/circular-alias",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration re-export could not be resolved from Installed Evidence.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  test.each([
    "@typepeek-fixture/named-re-export-missing-import",
    "@typepeek-fixture/named-re-export-missing-reference",
  ])(
    "rejects an unresolved selected named re-export graph for %s",
    async (specifier) => {
      const outcome = await inspectExport({
        exportName: "Visible",
        resolutionContext: getFixture().resolutionContext,
        specifier,
      });

      expect(outcome).toStrictEqual({
        message:
          "A declaration re-export could not be resolved from Installed Evidence.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    }
  );

  test("attributes re-exported declaration provenance to its owning Package Identity", async () => {
    const outcome = await inspectExport({
      exportName: "dependencyExport",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/compiled",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(outcome.result.moduleExport.alias).toBeUndefined();

    const valueSpace = outcome.result.moduleExport.spaces.find(
      ({ space }) => space === "value"
    );

    expect(
      valueSpace?.space === "value"
        ? valueSpace.declarations[0]?.provenance
        : undefined
    ).toMatchObject({
      file: "node_modules/@typepeek-fixture/dependency/dist/index.d.ts",
      packageIdentity: {
        name: "@typepeek-fixture/dependency",
        version: "1.0.0",
      },
    });
  });

  test("returns equivalent domain information for bundled and split declarations", async () => {
    const [bundled, split] = await Promise.all([
      inspectExport({
        exportName: "inspect",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/equivalent-bundled",
      }),
      inspectExport({
        exportName: "inspect",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/equivalent-split",
      }),
    ]);

    expect([bundled.status, split.status]).toStrictEqual([
      "success",
      "success",
    ]);

    if (
      bundled.status !== "success" ||
      split.status !== "success" ||
      bundled.result.intent !== "export-inspection" ||
      split.result.intent !== "export-inspection"
    ) {
      return;
    }

    expect({
      alias: split.result.moduleExport.alias,
      signatures: split.result.moduleExport.signatures,
      spaces: split.result.moduleExport.spaces.map(({ space }) => space),
      supportingTypes: split.result.supportingTypes.map(
        ({ name, declarations }) => ({
          declarations: declarations.map(({ kind, text }) => ({ kind, text })),
          name,
        })
      ),
    }).toStrictEqual({
      alias: bundled.result.moduleExport.alias,
      signatures: bundled.result.moduleExport.signatures,
      spaces: bundled.result.moduleExport.spaces.map(({ space }) => space),
      supportingTypes: bundled.result.supportingTypes.map(
        ({ name, declarations }) => ({
          declarations: declarations.map(({ kind, text }) => ({ kind, text })),
          name,
        })
      ),
    });
  });

  test("reports a missing focused Module Export", async () => {
    const outcome = await inspectExport({
      exportName: "missing",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toStrictEqual({
      message:
        'Module Export "missing" was not found in "@typepeek-fixture/focused".',
      reason: "export-not-found",
      status: "not-found",
    });
  });
};
