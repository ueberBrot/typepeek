import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "focused-alias-fixture";

beforeAll(async () => {
  resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-focused-aliases-"));
  const packageRoot = join(resolutionContext, "node_modules", specifier);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(resolutionContext, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: specifier,
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts" }, "./*": { types: "./*.d.ts" } },
    }),
  );
  const declarations = {
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
    "type-star.d.ts": 'export type * from "./star-base.js";',
    "transitive-star.d.ts": 'export * from "./type-star.js";',
    "imported-star.d.ts": 'import { StarWidget } from "./type-star.js"; export { StarWidget };',
    "renamed-star.d.ts": 'export { StarWidget as Renamed } from "./type-star.js";',
    "type-first.d.ts": 'export type * from "./star-base.js"; export * from "./star-base.js";',
    "value-first.d.ts": 'export * from "./star-base.js"; export type * from "./star-base.js";',
    "type-override.d.ts":
      'export * from "./star-base.js"; export type { StarWidget } from "./star-base.js";',
    "namespace-star.d.ts": 'export * as Types from "./type-star.js";',
    "type-namespace.d.ts": 'export type * as Types from "./star-base.js";',
    "cycle-a.d.ts": 'export * from "./cycle-b.js"; export type * from "./star-base.js";',
    "cycle-b.d.ts": 'export * from "./cycle-a.js";',
    "object-name.d.ts": 'export type { StarWidget as toString } from "./star-base.js";',
    "base.d.ts": `export default class Widget {
      constructor(value: string);
      readonly value: string;
      static readonly staticValue: number;
    }
    export { Widget };`,
    "named.d.ts": 'export type { Widget as Named } from "./base.js";',
    "star.d.ts": 'export type { Widget as ThroughStar } from "./base.js";',
    "value-star.d.ts": 'export { Widget as ValueThroughStar } from "./base.js";',
    "equals.d.cts": `declare class Widget {
      constructor(value: string);
      readonly value: string;
      static readonly staticValue: number;
    }
    export = Widget;`,
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
  };
  await Promise.all(
    Object.entries(declarations).map(([file, source]) =>
      writeFile(join(packageRoot, file), source),
    ),
  );
});

afterAll(async () => {
  await rm(resolutionContext, { recursive: true, force: true });
});

it.each(["Direct", "Transitive", "ThroughStar", "Imported", "DefaultImported", "EqualsImported"])(
  "preserves type-only access through %s in every focused inspection",
  async (exportName) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        resolutionContext,
        specifier,
        queries: [
          { intent: "export-inspection", exportName },
          { intent: "declaration-inspection", exportName },
          { intent: "signature-inspection", exportName },
          { intent: "member-discovery", exportName, query: "staticValue" },
          { intent: "member-inspection", exportName, memberPath: ["staticValue"] },
        ],
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "success" });
    if (outcome.status !== "success" || outcome.result.intent !== "inspection-plan") return;
    const [exportInspection, declarationInspection, signatureInspection] =
      outcome.result.inspections;
    expect(exportInspection).toMatchObject({
      intent: "export-inspection",
      moduleExport: { spaces: [{ space: "type" }], signatures: [] },
    });
    expect(declarationInspection).toMatchObject({
      intent: "declaration-inspection",
      moduleExport: { spaces: [{ space: "type" }] },
    });
    expect(signatureInspection).toMatchObject({
      intent: "signature-inspection",
      moduleExport: { signatures: [] },
    });
    // Type-only class imports still admit typeof queries on static members.
    expect(outcome.result.inspections[3]).toMatchObject({
      intent: "member-discovery",
      members: [{ name: "staticValue", spaces: ["value"] }],
    });
    expect(outcome.result.inspections[4]).toMatchObject({
      intent: "member-inspection",
      declarations: [{ kind: "property", text: "static readonly staticValue: number;" }],
    });
  },
);

it.each(["Value", "ValueThroughStar"])(
  "retains public constructor signatures for %s",
  async (exportName) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", {
        resolutionContext,
        specifier,
        exportName,
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: {
        moduleExport: {
          spaces: [{ space: "type" }, { space: "value" }],
          signatures: [{ kind: "construct", text: "new (value: string): Widget" }],
        },
      },
    });
  },
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
])("keeps contextual type-only access for %s", async (subpath, exportName) => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("inspection-plan", {
      resolutionContext,
      specifier: `${specifier}/${subpath}`,
      queries: [
        { intent: "export-inspection", exportName },
        { intent: "declaration-inspection", exportName },
        { intent: "signature-inspection", exportName },
        { intent: "member-inspection", exportName, memberPath: ["staticValue"] },
      ],
    }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      inspections: [
        { moduleExport: { spaces: [{ space: "type" }], signatures: [] } },
        { moduleExport: { spaces: [{ space: "type" }] } },
        { moduleExport: { signatures: [] } },
        { declarations: [{ kind: "property", text: "static readonly staticValue: number;" }] },
      ],
    },
  });
});

it.each(["type-first", "value-first"])(
  "preserves an alternate public value path through %s",
  async (subpath) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", {
        resolutionContext,
        specifier: `${specifier}/${subpath}`,
        exportName: "StarWidget",
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: {
        moduleExport: {
          spaces: [{ space: "type" }, { space: "value" }],
          signatures: [{ kind: "construct", text: "new (value: string): StarWidget" }],
        },
      },
    });
  },
);

it.each([
  ["type-star", 'type * from "./star-base.js";'],
  ["transitive-star", '* from "./type-star.js";'],
])(
  "retains real star declaration evidence for type-only values through %s",
  async (subpath, text) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        resolutionContext,
        specifier: `${specifier}/${subpath}`,
        queries: [
          { intent: "declaration-inspection", exportName: "factory" },
          { intent: "signature-inspection", exportName: "factory" },
          { intent: "declaration-inspection", exportName: "Space" },
        ],
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: {
        inspections: [
          {
            moduleExport: { spaces: [{ space: "type", declarations: [{ kind: "alias", text }] }] },
          },
          { moduleExport: { signatures: [] } },
          {
            moduleExport: { spaces: [{ space: "type", declarations: [{ kind: "alias", text }] }] },
          },
        ],
      },
    });
  },
);

it.each(["namespace-star", "type-namespace"])(
  "preserves namespace qualifiers beneath %s",
  async (subpath) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        resolutionContext,
        specifier: `${specifier}/${subpath}`,
        queries: [
          { intent: "export-inspection", exportName: "Types" },
          {
            intent: "member-inspection",
            exportName: "Types",
            memberPath: [
              { name: "Space", space: "namespace" },
              { name: "Options", space: "namespace" },
            ],
          },
        ],
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: {
        inspections: [
          { moduleExport: { name: "Types", signatures: [] } },
          {
            declarations: [
              { kind: "interface", text: "interface Options {\n    readonly enabled: boolean;\n}" },
            ],
          },
        ],
      },
    });
  },
);
