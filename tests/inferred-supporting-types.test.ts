import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "inferred-supporting-fixture";

describe("inferred-supporting-types", () => {
  beforeAll(async () => {
    resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-inferred-supporting-")
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
        name: specifier,
        type: "module",
        types: "index.ts",
        version: "1.0.0",
      })
    );
    await writeFile(
      nodePath.join(packageRoot, "index.ts"),
      `
    interface Item { readonly enabled: boolean; }
    export const directDefault = <T = Item>() => 1;
    export const identity = <T>(value: T) => value;
    declare function withIdentity<T>(): <U extends T = T>(value: U) => U;
    declare function withChain<T>(): <U extends T = T, V extends U = U>() => number;
    export declare function directChain<T extends Item, U extends T, V extends U>(): number;
    declare function withDefault<T>(): <U = T>() => number;
    declare function withConstraint<T>(): <U extends T>() => number;
    declare function withReceiver<T>(): (this: T) => number;
    declare function withIndex<T>(): { [key: string]: T };
    export const instantiatedDefault = withDefault<Item>();
    export const instantiatedConstraint = withConstraint<Item>();
    export const instantiatedReceiver = withReceiver<Item>();
    export const instantiatedIndex = withIndex<Item>();
    export const instantiatedIdentity = withIdentity<Item>();
    export const instantiatedChain = withChain<Item>();

    export function localDefault() {
      interface Hidden { readonly secret: string; }
      return withDefault<Hidden>();
    }
    export function localConstraint() {
      interface Hidden { readonly secret: string; }
      return withConstraint<Hidden>();
    }
    export function localReceiver() {
      interface Hidden { readonly secret: string; }
      return withReceiver<Hidden>();
    }
    export function localIndex() {
      interface Hidden { readonly secret: string; }
      return withIndex<Hidden>();
    }

    interface Recursive { readonly next: Recursive; }
    export const recursiveDefault = withDefault<Recursive>();
    export const recursiveIndex = withIndex<Recursive>();
  `
    );
  });

  afterAll(async () => {
    if (resolutionContext !== undefined) {
      await rm(resolutionContext, { force: true, recursive: true });
    }
  });

  it.each([
    "directDefault",
    "instantiatedDefault",
    "instantiatedConstraint",
    "instantiatedReceiver",
    "instantiatedIndex",
    "instantiatedIdentity",
  ])("retains Supporting Types on the inferred %s edge", async (exportName) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", {
        exportName,
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        supportingTypes: [
          { declarations: [{ kind: "interface" }], name: "Item" },
        ],
      },
      status: "success",
    });
  });

  it("preserves a public generic binder without inventing a Supporting Type", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", {
        exportName: "identity",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        moduleExport: {
          signatures: [{ kind: "call", text: "<T>(value: T): T" }],
        },
        supportingTypes: [],
      },
      status: "success",
    });
  });

  it.each([
    ["instantiatedConstraint", [{ constraint: "Item", name: "U" }]],
    [
      "instantiatedIdentity",
      [{ constraint: "Item", default: "Item", name: "U" }],
    ],
    [
      "instantiatedChain",
      [
        { constraint: "Item", default: "Item", name: "U" },
        { constraint: "U", default: "U", name: "V" },
      ],
    ],
    [
      "directChain",
      [
        { constraint: "Item", name: "T" },
        { constraint: "T", name: "U" },
        { constraint: "U", name: "V" },
      ],
    ],
    ["directDefault", [{ default: "Item", name: "T" }]],
  ] as const)(
    "preserves resolved and local signature constraints in %s",
    async (exportName, parameters) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("signature-inspection", {
          exportName,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        status: "success",
      });

      if (
        outcome.status !== "success" ||
        outcome.result.intent !== "signature-inspection"
      ) {
        return;
      }

      expect(
        outcome.result.moduleExport.signatures[0]?.typeParameters
      ).toStrictEqual(
        parameters.map((parameter) => ({
          ...parameter,
          modifiers: [],
          synthetic: false,
        }))
      );
    }
  );

  it.each(["localDefault", "localConstraint", "localReceiver", "localIndex"])(
    "rejects an implementation-local type reached through %s",
    async (exportName) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("export-inspection", {
          exportName,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        message:
          "An inferred Public Interface references an implementation-local type.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    }
  );

  it("terminates recursive Supporting Type edges across a shared Inspection Plan", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        queries: [
          { exportName: "recursiveDefault", intent: "export-inspection" },
          { exportName: "recursiveIndex", intent: "export-inspection" },
        ],
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        inspections: [
          { supportingTypes: [{ name: "Recursive" }] },
          { supportingTypes: [{ name: "Recursive" }] },
        ],
      },
      status: "success",
    });
  });
});
