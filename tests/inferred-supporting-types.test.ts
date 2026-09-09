import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "inferred-supporting-fixture";

beforeAll(async () => {
  resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-inferred-supporting-"));
  const packageRoot = join(resolutionContext, "node_modules", specifier);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(resolutionContext, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: specifier, version: "1.0.0", type: "module", types: "index.ts" }),
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    `
    interface Item { readonly enabled: boolean; }
    export const directDefault = <T = Item>() => 1;
    export const identity = <T>(value: T) => value;
    declare function withIdentity<T>(): <U extends T = T>(value: U) => U;
    declare function withDefault<T>(): <U = T>() => number;
    declare function withConstraint<T>(): <U extends T>() => number;
    declare function withReceiver<T>(): (this: T) => number;
    declare function withIndex<T>(): { [key: string]: T };
    export const instantiatedDefault = withDefault<Item>();
    export const instantiatedConstraint = withConstraint<Item>();
    export const instantiatedReceiver = withReceiver<Item>();
    export const instantiatedIndex = withIndex<Item>();
    export const instantiatedIdentity = withIdentity<Item>();

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
  `,
  );
});

afterAll(async () => {
  if (resolutionContext !== undefined) {
    await rm(resolutionContext, { recursive: true, force: true });
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
    invokeInspectionCore("export-inspection", { resolutionContext, specifier, exportName }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      supportingTypes: [{ name: "Item", declarations: [{ kind: "interface" }] }],
    },
  });
});

it("preserves a public generic binder without inventing a Supporting Type", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("export-inspection", {
      resolutionContext,
      specifier,
      exportName: "identity",
    }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      moduleExport: { signatures: [{ kind: "call", text: "<T>(value: T): T" }] },
      supportingTypes: [],
    },
  });
});

it.each(["localDefault", "localConstraint", "localReceiver", "localIndex"])(
  "rejects an implementation-local type reached through %s",
  async (exportName) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", { resolutionContext, specifier, exportName }),
    );
    expect(outcome).toMatchObject({
      status: "unsupported",
      reason: "unsupported-evidence",
      message: "An inferred Public Interface references an implementation-local type.",
    });
  },
);

it("terminates recursive Supporting Type edges across a shared Inspection Plan", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("inspection-plan", {
      resolutionContext,
      specifier,
      queries: [
        { intent: "export-inspection", exportName: "recursiveDefault" },
        { intent: "export-inspection", exportName: "recursiveIndex" },
      ],
    }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      inspections: [
        { supportingTypes: [{ name: "Recursive" }] },
        { supportingTypes: [{ name: "Recursive" }] },
      ],
    },
  });
});
