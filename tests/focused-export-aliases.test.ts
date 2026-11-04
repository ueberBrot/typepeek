import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

import { match } from "./helpers/matchers.ts";

let resolutionContext: string;
const specifier = "focused-alias-fixture";

describe("focused-export-aliases", () => {
  beforeAll(async () => {
    resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-focused-aliases-")
    );

    const packageRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      specifier
    );

    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      nodePath.join(resolutionContext, "package.json"),
      JSON.stringify({ type: "module" })
    );
    await writeFile(
      nodePath.join(packageRoot, "package.json"),
      JSON.stringify({
        exports: {
          ".": Object.fromEntries([["types", "./index.d.ts"]]),
          "./*": Object.fromEntries([["types", "./*.d.ts"]]),
        },
        name: specifier,
        type: "module",
        version: "1.0.0",
      })
    );

    const declarations = {
      "base.d.ts": `export default class Widget {
      constructor(value: string);
      readonly value: string;
      static readonly staticValue: number;
    }
    export { Widget };`,
      "cycle-a.d.ts":
        'export * from "./cycle-b.js"; export type * from "./star-base.js";',
      "cycle-b.d.ts": 'export * from "./cycle-a.js";',
      "equals.d.cts": `declare class Widget {
      constructor(value: string);
      readonly value: string;
      static readonly staticValue: number;
    }
    export = Widget;`,
      "imported-star.d.ts":
        'import { StarWidget } from "./type-star.js"; export { StarWidget };',
      "index.d.ts": `export type { Widget as Direct } from "./base.js";
    export { Widget as Value } from "./base.js";
    export { Named as Transitive } from "./named.js";
    export * from "./star.js";
    export * from "./value-star.js";
    import type { Widget as Imported } from "./base.js";
    export { Imported };
    import type DefaultImported from "./base.js";
    export { DefaultImported };
    import type EqualsImported = require("./equals.cjs");
    export { EqualsImported };`,
      "named.d.ts": 'export type { Widget as Named } from "./base.js";',
      "namespace-star.d.ts": 'export * as Types from "./type-star.js";',
      "object-name.d.ts":
        'export type { StarWidget as toString } from "./star-base.js";',
      "renamed-star.d.ts":
        'export { StarWidget as Renamed } from "./type-star.js";',
      "star-base.d.ts": `export declare class StarWidget {
      constructor(value: string);
      readonly value: string;
      static readonly staticValue: number;
    }
    export declare function factory(value: string): number;
    export declare namespace Space {
      interface Options { readonly enabled: boolean; }
      const answer: number;
    }`,
      "star.d.ts": 'export type { Widget as ThroughStar } from "./base.js";',
      "transitive-star.d.ts": 'export * from "./type-star.js";',
      "type-first.d.ts":
        'export type * from "./star-base.js"; export * from "./star-base.js";',
      "type-namespace.d.ts": 'export type * as Types from "./star-base.js";',
      "type-override.d.ts":
        'export * from "./star-base.js"; export type { StarWidget } from "./star-base.js";',
      "type-star.d.ts": 'export type * from "./star-base.js";',
      "value-first.d.ts":
        'export * from "./star-base.js"; export type * from "./star-base.js";',
      "value-star.d.ts":
        'export { Widget as ValueThroughStar } from "./base.js";',
    };

    await Promise.all(
      Object.entries(declarations).map(async ([file, source]) => {
        await writeFile(nodePath.join(packageRoot, file), source);
      })
    );
  });

  afterAll(async () => {
    await rm(resolutionContext, { force: true, recursive: true });
  });

  it.each([
    "Direct",
    "Transitive",
    "ThroughStar",
    "Imported",
    "DefaultImported",
    "EqualsImported",
  ])(
    "preserves type-only access through %s in every focused inspection",
    async (exportName) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("inspection-plan", {
          queries: [
            { exportName, intent: "export-inspection" },
            { exportName, intent: "declaration-inspection" },
            { exportName, intent: "signature-inspection" },
            { exportName, intent: "member-discovery", query: "staticValue" },
            {
              exportName,
              intent: "member-inspection",
              memberPath: ["staticValue"],
            },
          ],
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        status: "success",
      });

      if (
        outcome.status !== "success" ||
        outcome.result.intent !== "inspection-plan"
      ) {
        return;
      }

      const [exportInspection, declarationInspection, signatureInspection] =
        outcome.result.inspections;

      expect([
        exportInspection,
        declarationInspection,
        signatureInspection,
        outcome.result.inspections[3],
        outcome.result.inspections[4],
      ]).toStrictEqual([
        match.objectContaining({
          intent: "export-inspection",
          moduleExport: match.objectContaining({
            signatures: [],
            spaces: [match.objectContaining({ space: "type" })],
          }),
        }),
        match.objectContaining({
          intent: "declaration-inspection",
          moduleExport: match.objectContaining({
            spaces: [match.objectContaining({ space: "type" })],
          }),
        }),
        match.objectContaining({
          intent: "signature-inspection",
          moduleExport: match.objectContaining({ signatures: [] }),
        }),
        match.objectContaining({
          intent: "member-discovery",
          members: [
            match.objectContaining({ name: "staticValue", spaces: ["value"] }),
          ],
        }),
        match.objectContaining({
          declarations: [
            match.objectContaining({
              kind: "property",
              text: "static readonly staticValue: number;",
            }),
          ],
          intent: "member-inspection",
        }),
      ]);
    }
  );

  it.each(["Value", "ValueThroughStar"])(
    "retains public constructor signatures for %s",
    async (exportName) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("export-inspection", {
          exportName,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        result: {
          moduleExport: {
            signatures: [
              { kind: "construct", text: "new (value: string): Widget" },
            ],
            spaces: [{ space: "type" }, { space: "value" }],
          },
        },
        status: "success",
      });
    }
  );

  it.each([
    ["type-star", "StarWidget"],
    ["transitive-star", "StarWidget"],
    ["imported-star", "StarWidget"],
    ["renamed-star", "Renamed"],
    ["type-override", "StarWidget"],
    ["cycle-a", "StarWidget"],
    ["cycle-b", "StarWidget"],
    ["object-name", "toString"],
  ])(
    "keeps contextual type-only access for %s",
    async (subpath, exportName) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("inspection-plan", {
          queries: [
            { exportName, intent: "export-inspection" },
            { exportName, intent: "declaration-inspection" },
            { exportName, intent: "signature-inspection" },
            {
              exportName,
              intent: "member-inspection",
              memberPath: ["staticValue"],
            },
          ],
          resolutionContext,
          specifier: `${specifier}/${subpath}`,
        })
      );

      expect(outcome).toMatchObject({
        result: {
          inspections: [
            { moduleExport: { signatures: [], spaces: [{ space: "type" }] } },
            { moduleExport: { spaces: [{ space: "type" }] } },
            { moduleExport: { signatures: [] } },
            {
              declarations: [
                {
                  kind: "property",
                  text: "static readonly staticValue: number;",
                },
              ],
            },
          ],
        },
        status: "success",
      });
    }
  );

  it.each(["type-first", "value-first"])(
    "preserves an alternate public value path through %s",
    async (subpath) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("export-inspection", {
          exportName: "StarWidget",
          resolutionContext,
          specifier: `${specifier}/${subpath}`,
        })
      );

      expect(outcome).toMatchObject({
        result: {
          moduleExport: {
            signatures: [
              { kind: "construct", text: "new (value: string): StarWidget" },
            ],
            spaces: [{ space: "type" }, { space: "value" }],
          },
        },
        status: "success",
      });
    }
  );

  it.each([
    ["type-star", 'type * from "./star-base.js";'],
    ["transitive-star", '* from "./type-star.js";'],
  ])(
    "retains real star declaration evidence for type-only values through %s",
    async (subpath, text) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("inspection-plan", {
          queries: [
            { exportName: "factory", intent: "declaration-inspection" },
            { exportName: "factory", intent: "signature-inspection" },
            { exportName: "Space", intent: "declaration-inspection" },
          ],
          resolutionContext,
          specifier: `${specifier}/${subpath}`,
        })
      );

      expect(outcome).toMatchObject({
        result: {
          inspections: [
            {
              moduleExport: {
                spaces: [
                  { declarations: [{ kind: "alias", text }], space: "type" },
                ],
              },
            },
            { moduleExport: { signatures: [] } },
            {
              moduleExport: {
                spaces: [
                  { declarations: [{ kind: "alias", text }], space: "type" },
                ],
              },
            },
          ],
        },
        status: "success",
      });
    }
  );

  it.each(["namespace-star", "type-namespace"])(
    "preserves namespace qualifiers beneath %s",
    async (subpath) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("inspection-plan", {
          queries: [
            { exportName: "Types", intent: "export-inspection" },
            {
              exportName: "Types",
              intent: "member-inspection",
              memberPath: [
                { name: "Space", space: "namespace" },
                { name: "Options", space: "namespace" },
              ],
            },
          ],
          resolutionContext,
          specifier: `${specifier}/${subpath}`,
        })
      );

      expect(outcome).toMatchObject({
        result: {
          inspections: [
            { moduleExport: { name: "Types", signatures: [] } },
            {
              declarations: [
                {
                  kind: "interface",
                  text: "interface Options {\n    readonly enabled: boolean;\n}",
                },
              ],
            },
          ],
        },
        status: "success",
      });
    }
  );
});
