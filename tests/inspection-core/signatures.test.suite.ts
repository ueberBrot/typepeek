import { expect, test } from "vite-plus/test";

import { inspectExport, inspectExportSignatures } from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerSignatureTests = function registerSignatureTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("preserves callable and constructable signature order", async () => {
    const outcome = await inspectExport({
      exportName: "widgetFactory",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (
      outcome.status !== "success" ||
      outcome.result.intent !== "export-inspection"
    ) {
      return;
    }

    expect(outcome.result.moduleExport.signatures).toStrictEqual([
      {
        kind: "call",
        text: "(input: WidgetInput): WidgetResult",
      },
      {
        kind: "construct",
        text: "new (input: WidgetInput): WidgetResult",
      },
      {
        kind: "call",
        text: "(input: string, options: WidgetOptions): WidgetResult",
      },
      {
        kind: "construct",
        text: "new (input: string, options: WidgetOptions): WidgetResult",
      },
    ]);
  });

  test("inspects signatures without traversing Supporting Types", async () => {
    const outcome = await inspectExportSignatures({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/deep-supporting-types",
    });

    expect(outcome).toMatchObject({
      result: {
        intent: "signature-inspection",
        moduleExport: {
          name: "inspect",
          signatures: [
            {
              kind: "call",
              parameters: [
                {
                  binding: {
                    kind: "identifier",
                    name: "value",
                    synthetic: false,
                  },
                  optional: false,
                  rest: false,
                  type: "Depth0",
                },
              ],
              returns: { kind: "type", type: "void" },
              text: "(value: Depth0): void",
              typeParameters: [],
            },
          ],
        },
        packageIdentity: {
          name: "@typepeek-fixture/deep-supporting-types",
          version: "1.0.0",
        },
        specifier: "@typepeek-fixture/deep-supporting-types",
      },
      status: "success",
    });
  });

  test("structures generic, this, optional, and rest Signature Inspection inputs", async () => {
    const outcome = await inspectExportSignatures({
      exportName: "detailed",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect([
      outcome.result.moduleExport.signatures.length,
      outcome.result.moduleExport.signatures[0],
    ]).toStrictEqual([
      1,
      match.objectContaining({
        kind: "call",
        parameters: [
          match.objectContaining({
            binding: match.objectContaining({
              kind: "identifier",
              name: "value",
              synthetic: false,
            }),
            optional: false,
            rest: false,
            type: "T",
          }),
          match.objectContaining({
            binding: match.objectContaining({
              kind: "identifier",
              name: "options",
              synthetic: false,
            }),
            optional: true,
            rest: false,
            type: "WidgetOptions | undefined",
          }),
          match.objectContaining({
            binding: match.objectContaining({
              kind: "identifier",
              name: "rest",
              synthetic: false,
            }),
            optional: true,
            rest: true,
            type: "[count?: number | undefined]",
          }),
        ],
        returns: match.objectContaining({ kind: "type", type: "T" }),
        thisParameter: match.objectContaining({
          type: "{ readonly scope: T; }",
        }),
        typeParameters: [
          match.objectContaining({
            constraint: "string",
            default: "string",
            modifiers: ["const"],
            name: "T",
            synthetic: false,
          }),
        ],
      }),
    ]);
  });

  test("preserves binding patterns, predicates, assertions, and constructed instance types", async () => {
    const outcomes = await Promise.all(
      [
        "destructure",
        "isWidget",
        "assertWidget",
        "assertPresent",
        "detailedConstructor",
      ].map(
        async (exportName) =>
          await inspectExportSignatures({
            exportName,
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          })
      )
    );

    expect(outcomes.every(({ status }) => status === "success")).toBeTruthy();

    const results = outcomes.map((outcome) => {
      if (outcome.status !== "success") {
        throw new Error(outcome.message);
      }

      return outcome.result;
    });

    const [
      destructure,
      predicate,
      assertion,
      bareAssertion,
      constructorDeclaration,
    ] = results;

    expect([
      destructure?.moduleExport.signatures[0],
      predicate?.moduleExport.signatures[0]?.returns,
      assertion?.moduleExport.signatures[0]?.returns,
      bareAssertion?.moduleExport.signatures[0]?.returns,
      constructorDeclaration?.moduleExport.signatures[0],
    ]).toStrictEqual([
      match.objectContaining({
        parameters: [
          match.objectContaining({
            binding: match.objectContaining({
              kind: "pattern",
              text: "{ name: renamed, nested: [first] }",
            }),
            optional: false,
            rest: false,
          }),
          match.objectContaining({
            binding: match.objectContaining({
              kind: "identifier",
              name: "rest",
              synthetic: false,
            }),
            optional: true,
            rest: true,
          }),
        ],
      }),
      {
        kind: "predicate",
        parameter: "value",
        type: "Widget",
      },
      {
        kind: "assertion",
        parameter: "value",
        type: "Widget",
      },
      {
        kind: "assertion",
        parameter: "value",
      },
      match.objectContaining({
        kind: "construct",
        returns: match.objectContaining({
          kind: "type",
          type: "T & WidgetResult",
        }),
        typeParameters: [
          match.objectContaining({ constraint: "WidgetInput", name: "T" }),
        ],
      }),
    ]);
  });

  test("renders signatures on a callable and constructable type-only Module Export", async () => {
    const outcome = await inspectExport({
      exportName: "WidgetFactory",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect([
      outcome.result.moduleExport.spaces.map(({ space }) => space),
      outcome.result.moduleExport.signatures.map(({ kind }) => kind),
    ]).toStrictEqual([["type"], ["call", "construct", "call", "construct"]]);
  });
};
