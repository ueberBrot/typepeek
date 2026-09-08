import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "member-fixture";

beforeAll(async () => {
  resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-members-"));
  const packageRoot = join(resolutionContext, "node_modules", specifier);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(resolutionContext, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: specifier,
      version: "1.0.0",
      type: "module",
      exports: {
        ".": { types: "./index.d.ts" },
        "./too-many": { types: "./too-many.d.ts" },
        "./broad-barrel": { types: "./broad-entry.d.ts" },
      },
    }),
  );
  await writeFile(join(packageRoot, "bar.d.ts"), 'export * from "./inner.js";');
  await writeFile(
    join(packageRoot, "too-many.d.ts"),
    `export interface TooMany {
    ${Array.from({ length: 4097 }, (_, index) => `entry${index}: number;`).join("\n")}
  }`,
  );
  await writeFile(
    join(packageRoot, "broad-entry.d.ts"),
    'export * as BroadBarrel from "./broad-barrel.js";',
  );
  await writeFile(join(packageRoot, "broad-barrel.d.ts"), 'export * from "./broad-types.js";');
  await writeFile(
    join(packageRoot, "broad-types.d.ts"),
    Array.from(
      { length: 4097 },
      (_, index) => `export interface Type${index} { readonly value: number; }`,
    ).join("\n"),
  );
  await writeFile(
    join(packageRoot, "cycle-a.d.ts"),
    'export * from "./cycle-b.js"; export interface A { readonly value: string; }',
  );
  await writeFile(
    join(packageRoot, "cycle-b.d.ts"),
    'export * from "./cycle-a.js"; export interface B { readonly value: number; }',
  );
  await writeFile(
    join(packageRoot, "inner.d.ts"),
    "export interface Options { readonly enabled: boolean; } export declare const value: number;",
  );
  await writeFile(
    join(packageRoot, "index.d.ts"),
    `
    declare class Base { readonly inherited: string; protected hidden: string; }
    export declare class Shape extends Base {
      readonly shared: string;
      readonly nested: { readonly leaf: number };
      private secret: string;
      static readonly staticOnly: boolean;
    }
    export declare namespace Shape { const shared: number; }
    export { Shape as AliasShape };
    export declare namespace Tree {
      class Choice { readonly shared: string; }
      namespace Choice { const shared: number; }
      export import Alias = Choice;
    }
    export type Mapped = { [K in "foo" | "bar"]: string };
    export * as Bar from "./bar.js";
    export * as Cycle from "./cycle-a.js";
    export interface Recursive { next: Recursive; }
    export interface EmptyDeep { ${"next: {".repeat(16)} ${"}".repeat(16)} }
    export interface Names { readonly "a.b": string; readonly "space:name": number; }
    export declare namespace Wide {
      ${Array.from({ length: 300 }, (_, index) => `const entry${index}: number;`).join("\n")}
    }
    export interface OversizedName { readonly "${"x".repeat(257)}": string; }
    export interface EmptyName { readonly "": string; }
    export interface LiteralInternalName { readonly "__@literal": string; }
    declare const Symbol: { readonly iterator: unique symbol };
    export interface SymbolName { [Symbol.iterator](): unknown; }
  `,
  );
});

afterAll(async () => {
  await rm(resolutionContext, { recursive: true, force: true });
});

it("discovers public member names and usable spaces without rendering declarations", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", { resolutionContext, specifier, exportName: "Shape" }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      intent: "member-discovery",
      moduleExportName: "Shape",
      memberPath: [],
      totalMembers: 4,
      members: [
        { name: "inherited", spaces: ["type"] },
        { name: "nested", spaces: ["type"] },
        { name: "shared", spaces: ["type", "value", "namespace"] },
        { name: "staticOnly", spaces: ["value", "namespace"] },
      ],
    },
  });
  if (outcome.status === "success") {
    expect(outcome.result).not.toHaveProperty("declarations");
    expect(outcome.result).not.toHaveProperty("supportingTypes");
  }
});

it("filters names case-insensitively while retaining the complete public name count", async () => {
  for (const [query, names] of [
    ["SHAR", ["shared"]],
    ["absent", []],
  ] as const) {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        resolutionContext,
        specifier,
        exportName: "Shape",
        query,
      }),
    );
    expect(outcome).toMatchObject({
      status: "success",
      result: { query, totalMembers: 4, members: names.map((name) => ({ name })) },
    });
  }
});

it("uses every discovered space for exact follow-up inspection", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", { resolutionContext, specifier, exportName: "Shape" }),
  );
  if (outcome.status !== "success" || outcome.result.intent !== "member-discovery") {
    throw new Error(JSON.stringify(outcome));
  }
  for (const member of outcome.result.members) {
    for (const space of member.spaces) {
      const memberPath = [{ name: member.name, space }];
      const { outcome: selected } = await Effect.runPromise(
        invokeInspectionCore("member-inspection", {
          resolutionContext,
          specifier,
          exportName: "Shape",
          memberPath,
        }),
      );
      expect(selected, JSON.stringify(selected)).toMatchObject({
        status: "success",
        result: { memberPath, declarations: expect.any(Array) },
      });
    }
  }
});

it("selects distinct type and namespace declarations while retaining unqualified ambiguity", async () => {
  for (const [space, text] of [
    ["type", "readonly shared: string;"],
    ["namespace", "shared: number"],
  ] as const) {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        resolutionContext,
        specifier,
        exportName: "Shape",
        memberPath: [{ name: "shared", space }],
      }),
    );
    expect(outcome).toMatchObject({ status: "success", result: { declarations: [{ text }] } });
  }
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-inspection", {
      resolutionContext,
      specifier,
      exportName: "Shape",
      memberPath: ["shared"],
    }),
  );
  expect(outcome).toMatchObject({ status: "unsupported", reason: "ambiguous-member" });
});

it("discovers a nested path and selects each exact segment", async () => {
  const memberPath = [{ name: "nested", space: "type" }];
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "Shape",
      memberPath,
    }),
  );
  expect(outcome).toMatchObject({
    status: "success",
    result: { memberPath, totalMembers: 1, members: [{ name: "leaf", spaces: ["value"] }] },
  });
  const { outcome: selected } = await Effect.runPromise(
    invokeInspectionCore("member-inspection", {
      resolutionContext,
      specifier,
      exportName: "Shape",
      memberPath: [...memberPath, { name: "leaf", space: "value" }],
    }),
  );
  expect(selected).toMatchObject({
    status: "success",
    result: { declarations: [{ text: "readonly leaf: number;" }] },
  });
});

it("follows Module Export aliases and namespace aliases before selecting a nested declaration space", async () => {
  const { outcome: aliased } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "AliasShape",
      query: "shared",
    }),
  );
  expect(aliased).toMatchObject({
    status: "success",
    result: {
      totalMembers: 4,
      members: [{ name: "shared", spaces: ["type", "value", "namespace"] }],
    },
  });
  for (const [space, text] of [
    ["type", "readonly shared: string;"],
    ["namespace", "shared: number"],
  ] as const) {
    const memberPath = [
      { name: "Alias", space: "namespace" },
      { name: "shared", space },
    ];
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        resolutionContext,
        specifier,
        exportName: "Tree",
        memberPath,
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: { memberPath, declarations: [{ text }] },
    });
  }
  const { outcome: nested } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "Tree",
      memberPath: [{ name: "Alias", space: "namespace" }],
    }),
  );
  expect(nested).toMatchObject({
    status: "success",
    result: {
      totalMembers: 1,
      members: [{ name: "shared", spaces: ["type", "value", "namespace"] }],
    },
  });
});

it("preserves punctuation as part of exact names", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", { resolutionContext, specifier, exportName: "Names" }),
  );
  expect(outcome).toMatchObject({
    status: "success",
    result: {
      totalMembers: 2,
      members: [
        { name: "a.b", spaces: ["type"] },
        { name: "space:name", spaces: ["type"] },
      ],
    },
  });
  const { outcome: selected } = await Effect.runPromise(
    invokeInspectionCore("member-inspection", {
      resolutionContext,
      specifier,
      exportName: "Names",
      memberPath: [{ name: "a.b", space: "type" }],
    }),
  );
  expect(selected).toMatchObject({
    status: "success",
    result: { declarations: [{ text: 'readonly "a.b": string;' }] },
  });
});

it("searches wide namespaces without rendering their complete declarations", async () => {
  const { outcome: broad } = await Effect.runPromise(
    invokeInspectionCore("export-inspection", { resolutionContext, specifier, exportName: "Wide" }),
  );
  expect(broad).toMatchObject({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "namespace-members",
  });
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "Wide",
      query: "entry299",
    }),
  );
  expect(outcome).toMatchObject({
    status: "success",
    result: { totalMembers: 300, members: [{ name: "entry299", spaces: ["value", "namespace"] }] },
  });
});

it.each([
  [specifier, "Wide", undefined, "member-matches"],
  [`${specifier}/too-many`, "TooMany", "absent", "member-candidates"],
])(
  "fails atomically for %s at its member budget",
  async (selectedSpecifier, exportName, query, exceededBudget) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        resolutionContext,
        specifier: selectedSpecifier,
        exportName,
        ...(query === undefined ? {} : { query }),
      }),
    );
    expect(outcome).toMatchObject({
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget,
    });
    expect(outcome).not.toHaveProperty("result");
  },
);

it.each([
  ["missing", [], "export-not-found"],
  ["Shape", ["missing"], "member-not-found"],
  ["Shape", ["secret"], "member-not-found"],
  ["Shape", ["hidden"], "member-not-found"],
  ["Shape", ["shared"], "ambiguous-member"],
])("retains typed discovery failures for %s at %j", async (exportName, memberPath, reason) => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName,
      memberPath,
    }),
  );
  expect(outcome).toMatchObject({ reason });
  expect(outcome).not.toHaveProperty("result");
});

it("shares qualified discovery and inspection paths in all-or-nothing plans", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("inspection-plan", {
      resolutionContext,
      specifier,
      queries: [
        {
          intent: "member-discovery",
          exportName: "Shape",
          memberPath: [{ name: "nested", space: "type" }],
        },
        {
          intent: "member-inspection",
          exportName: "Shape",
          memberPath: [
            { name: "nested", space: "type" },
            { name: "leaf", space: "value" },
          ],
        },
      ],
    }),
  );
  expect(outcome).toMatchObject({
    status: "success",
    result: {
      intent: "inspection-plan",
      inspections: [
        {
          intent: "member-discovery",
          totalMembers: 1,
          members: [{ name: "leaf", spaces: ["value"] }],
        },
        { intent: "member-inspection", declarations: [{ text: "readonly leaf: number;" }] },
      ],
    },
  });
  const { outcome: failed } = await Effect.runPromise(
    invokeInspectionCore("inspection-plan", {
      resolutionContext,
      specifier,
      queries: [
        { intent: "member-discovery", exportName: "Shape" },
        { intent: "member-discovery", exportName: "Wide" },
      ],
    }),
  );
  expect(failed).toMatchObject({ status: "limit-exceeded", exceededBudget: "member-matches" });
  expect(failed).not.toHaveProperty("result");
});

it.each(["OversizedName", "EmptyName", "SymbolName"])(
  "rejects %s when a public name has no bounded exact selector",
  async (exportName) => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", { resolutionContext, specifier, exportName }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "unsupported",
      reason: "unsupported-evidence",
    });
    expect(outcome).not.toHaveProperty("result");
  },
);

it("keeps string names that resemble compiler-generated symbols selectable", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "LiteralInternalName",
    }),
  );
  expect(outcome).toMatchObject({
    status: "success",
    result: { totalMembers: 1, members: [{ name: "__@literal", spaces: ["type"] }] },
  });
  const { outcome: selected } = await Effect.runPromise(
    invokeInspectionCore("member-inspection", {
      resolutionContext,
      specifier,
      exportName: "LiteralInternalName",
      memberPath: [{ name: "__@literal", space: "type" }],
    }),
  );
  expect(selected).toMatchObject({
    status: "success",
    result: { declarations: [{ text: 'readonly "__@literal": string;' }] },
  });
});

it("accounts Member candidates across every query in an Inspection Plan", async () => {
  const queries = Array.from({ length: 7 }, () => ({
    intent: "member-discovery",
    exportName: "Wide",
    query: "entry299",
  }));
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("inspection-plan", { resolutionContext, specifier, queries }),
  );
  expect(outcome).toMatchObject({ status: "limit-exceeded", exceededBudget: "member-candidates" });
  expect(outcome).not.toHaveProperty("result");
});

it("rejects discovery at the path-depth limit when a child selector cannot fit", async () => {
  const memberPath = Array.from({ length: 16 }, () => "next");
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "Recursive",
      memberPath,
    }),
  );
  expect(outcome).toMatchObject({
    status: "unsupported",
    reason: "unsupported-evidence",
    message: "Member Discovery cannot select children beyond the Member path depth limit.",
  });
  const { outcome: empty } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "EmptyDeep",
      memberPath,
    }),
  );
  expect(empty, JSON.stringify(empty)).toMatchObject({
    status: "success",
    result: { memberPath, totalMembers: 0, members: [] },
  });
});

it("fails explicitly when mapped public members lack declaration evidence", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier,
      exportName: "Mapped",
    }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "unsupported",
    reason: "unsupported-evidence",
  });
  expect(outcome).not.toHaveProperty("result");
  const { outcome: selected } = await Effect.runPromise(
    invokeInspectionCore("member-inspection", {
      resolutionContext,
      specifier,
      exportName: "Mapped",
      memberPath: [{ name: "foo", space: "type" }],
    }),
  );
  expect(selected).toMatchObject({ status: "unsupported", reason: "no-static-representation" });
});

it("discovers resolved namespace reexports and selects each advertised space", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", { resolutionContext, specifier, exportName: "Bar" }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      totalMembers: 2,
      members: [
        { name: "Options", spaces: ["namespace"] },
        { name: "value", spaces: ["value", "namespace"] },
      ],
    },
  });
  if (outcome.status !== "success" || outcome.result.intent !== "member-discovery") {
    throw new Error(JSON.stringify(outcome));
  }
  for (const member of outcome.result.members) {
    for (const space of member.spaces) {
      const { outcome: selected } = await Effect.runPromise(
        invokeInspectionCore("member-inspection", {
          resolutionContext,
          specifier,
          exportName: "Bar",
          memberPath: [{ name: member.name, space }],
        }),
      );
      expect(selected, JSON.stringify(selected)).toMatchObject({
        status: "success",
        result: { declarations: expect.any(Array) },
      });
    }
  }
});

it("bounds barrel expansion before namespace and value member lookup", async () => {
  for (const space of ["namespace", "value"] as const) {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        resolutionContext,
        specifier: `${specifier}/broad-barrel`,
        exportName: "BroadBarrel",
        memberPath: [{ name: "Type4096", space }],
      }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "limit-exceeded",
      exceededBudget: "member-candidates",
    });
    expect(outcome).not.toHaveProperty("result");
  }
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", {
      resolutionContext,
      specifier: `${specifier}/broad-barrel`,
      exportName: "BroadBarrel",
      query: "absent",
    }),
  );
  expect(outcome).toMatchObject({ status: "limit-exceeded", exceededBudget: "member-candidates" });
});

it("resolves cyclic namespace barrels without duplicating names", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("member-discovery", { resolutionContext, specifier, exportName: "Cycle" }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      totalMembers: 2,
      members: [
        { name: "A", spaces: ["namespace"] },
        { name: "B", spaces: ["namespace"] },
      ],
    },
  });
});
