import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

import { match } from "./helpers/matchers.ts";

let resolutionContext: string;
const specifier = "member-fixture";

const assertMissingValueMember = async (exportName: string): Promise<void> => {
  const { outcome: inaccessible } = await Effect.runPromise(
    invokeInspectionCore("member-inspection", {
      exportName,
      memberPath: [{ name: "C", space: "value" }],
      resolutionContext,
      specifier,
    })
  );

  expect(inaccessible).toMatchObject({
    reason: "member-not-found",
    status: "not-found",
  });
};

describe("member-discovery", () => {
  beforeAll(async () => {
    resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-members-")
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
          "./broad-barrel": Object.fromEntries([
            ["types", "./broad-entry.d.ts"],
          ]),
          "./too-many": Object.fromEntries([["types", "./too-many.d.ts"]]),
        },
        name: specifier,
        type: "module",
        version: "1.0.0",
      })
    );
    await writeFile(
      nodePath.join(packageRoot, "bar.d.ts"),
      'export * from "./inner.js";'
    );
    await Promise.all(
      Object.entries({
        "named-type-bar.d.ts":
          'export type { C, f, toString, I } from "./type-members.js";',
        "transitive-type-bar.d.ts": 'export * from "./type-bar.js";',
        "type-and-value-bar.d.ts":
          'export type * from "./type-members.js"; export * from "./type-members.js";',
        "type-bar.d.ts": 'export type * from "./type-members.js";',
        "type-members.d.ts": `export declare class C { readonly value: string; }
        export declare function f(): number;
        export declare function toString(): string;
        export interface I { readonly value: number; }`,
      }).map(async ([file, source]) => {
        await writeFile(nodePath.join(packageRoot, file), source);
      })
    );
    await writeFile(
      nodePath.join(packageRoot, "too-many.d.ts"),
      `export interface TooMany {
    ${Array.from({ length: 4097 }, (_, index) => `entry${index}: number;`).join("\n")}
  }`
    );
    await writeFile(
      nodePath.join(packageRoot, "broad-entry.d.ts"),
      'export * as BroadBarrel from "./broad-barrel.js";'
    );
    await writeFile(
      nodePath.join(packageRoot, "broad-barrel.d.ts"),
      'export * from "./broad-types.js";'
    );
    await writeFile(
      nodePath.join(packageRoot, "broad-types.d.ts"),
      Array.from(
        { length: 4097 },
        (_, index) =>
          `export interface Type${index} { readonly value: number; }`
      ).join("\n")
    );
    await writeFile(
      nodePath.join(packageRoot, "cycle-a.d.ts"),
      'export * from "./cycle-b.js"; export interface A { readonly value: string; }'
    );
    await writeFile(
      nodePath.join(packageRoot, "cycle-b.d.ts"),
      'export * from "./cycle-a.js"; export interface B { readonly value: number; }'
    );
    await writeFile(
      nodePath.join(packageRoot, "inner.d.ts"),
      "export interface Options { readonly enabled: boolean; } export declare const value: number;"
    );
    await writeFile(
      nodePath.join(packageRoot, "index.d.ts"),
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
    export * as TypeBar from "./type-bar.js";
    export * as TransitiveTypeBar from "./transitive-type-bar.js";
    export * as NamedTypeBar from "./named-type-bar.js";
    export * as TypeAndValueBar from "./type-and-value-bar.js";
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
  `
    );
  });

  afterAll(async () => {
    await rm(resolutionContext, { force: true, recursive: true });
  });

  it("discovers public member names and usable spaces without rendering declarations", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Shape",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        intent: "member-discovery",
        memberPath: [],
        members: [
          { name: "inherited", spaces: ["type"] },
          { name: "nested", spaces: ["type"] },
          { name: "shared", spaces: ["type", "value", "namespace"] },
          { name: "staticOnly", spaces: ["value", "namespace"] },
        ],
        moduleExportName: "Shape",
        totalMembers: 4,
      },
      status: "success",
    });

    if (outcome.status !== "success") {
      throw new Error("Expected a successful inspection result.");
    }

    expect(outcome.result).not.toHaveProperty("declarations");
    expect(outcome.result).not.toHaveProperty("supportingTypes");
  });

  it("filters names case-insensitively while retaining the complete public name count", async () => {
    await Array.fromAsync(
      [
        ["SHAR", ["shared"]],
        ["absent", []],
      ] as const,
      async ([query, names]) => {
        const { outcome } = await Effect.runPromise(
          invokeInspectionCore("member-discovery", {
            exportName: "Shape",
            query,
            resolutionContext,
            specifier,
          })
        );

        expect(outcome).toMatchObject({
          result: {
            members: names.map((name) => ({ name })),
            query,
            totalMembers: 4,
          },
          status: "success",
        });
      }
    );
  });

  it("uses every discovered space for exact follow-up inspection", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Shape",
        resolutionContext,
        specifier,
      })
    );

    if (
      outcome.status !== "success" ||
      outcome.result.intent !== "member-discovery"
    ) {
      throw new Error(JSON.stringify(outcome));
    }

    await Array.fromAsync(outcome.result.members, async (member) => {
      await Array.fromAsync(member.spaces, async (space) => {
        const memberPath = [{ name: member.name, space }];

        const { outcome: selected } = await Effect.runPromise(
          invokeInspectionCore("member-inspection", {
            exportName: "Shape",
            memberPath,
            resolutionContext,
            specifier,
          })
        );

        expect(selected).toMatchObject({
          result: { declarations: match.any(Array), memberPath },
          status: "success",
        });
      });
    });
  });

  it("selects distinct type and namespace declarations while retaining unqualified ambiguity", async () => {
    await Array.fromAsync(
      [
        ["type", "readonly shared: string;"],
        ["namespace", "shared: number"],
      ] as const,
      async ([space, text]) => {
        const { outcome } = await Effect.runPromise(
          invokeInspectionCore("member-inspection", {
            exportName: "Shape",
            memberPath: [{ name: "shared", space }],
            resolutionContext,
            specifier,
          })
        );

        expect(outcome).toMatchObject({
          result: { declarations: [{ text }] },
          status: "success",
        });
      }
    );

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        exportName: "Shape",
        memberPath: ["shared"],
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      reason: "ambiguous-member",
      status: "unsupported",
    });
  });

  it("discovers a nested path and selects each exact segment", async () => {
    const memberPath = [{ name: "nested", space: "type" }];

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Shape",
        memberPath,
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        memberPath,
        members: [{ name: "leaf", spaces: ["value"] }],
        totalMembers: 1,
      },
      status: "success",
    });

    const { outcome: selected } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        exportName: "Shape",
        memberPath: [...memberPath, { name: "leaf", space: "value" }],
        resolutionContext,
        specifier,
      })
    );

    expect(selected).toMatchObject({
      result: { declarations: [{ text: "readonly leaf: number;" }] },
      status: "success",
    });
  });

  it("follows Module Export aliases and namespace aliases before selecting a nested declaration space", async () => {
    const { outcome: aliased } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "AliasShape",
        query: "shared",
        resolutionContext,
        specifier,
      })
    );

    expect(aliased).toMatchObject({
      result: {
        members: [{ name: "shared", spaces: ["type", "value", "namespace"] }],
        totalMembers: 4,
      },
      status: "success",
    });

    await Array.fromAsync(
      [
        ["type", "readonly shared: string;"],
        ["namespace", "shared: number"],
      ] as const,
      async ([space, text]) => {
        const memberPath = [
          { name: "Alias", space: "namespace" },
          { name: "shared", space },
        ];

        const { outcome } = await Effect.runPromise(
          invokeInspectionCore("member-inspection", {
            exportName: "Tree",
            memberPath,
            resolutionContext,
            specifier,
          })
        );

        expect(outcome).toMatchObject({
          result: { declarations: [{ text }], memberPath },
          status: "success",
        });
      }
    );

    const { outcome: nested } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Tree",
        memberPath: [{ name: "Alias", space: "namespace" }],
        resolutionContext,
        specifier,
      })
    );

    expect(nested).toMatchObject({
      result: {
        members: [{ name: "shared", spaces: ["type", "value", "namespace"] }],
        totalMembers: 1,
      },
      status: "success",
    });
  });

  it("preserves punctuation as part of exact names", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Names",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        members: [
          { name: "a.b", spaces: ["type"] },
          { name: "space:name", spaces: ["type"] },
        ],
        totalMembers: 2,
      },
      status: "success",
    });

    const { outcome: selected } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        exportName: "Names",
        memberPath: [{ name: "a.b", space: "type" }],
        resolutionContext,
        specifier,
      })
    );

    expect(selected).toMatchObject({
      result: { declarations: [{ text: 'readonly "a.b": string;' }] },
      status: "success",
    });
  });

  it("searches wide namespaces without rendering their complete declarations", async () => {
    const { outcome: broad } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", {
        exportName: "Wide",
        resolutionContext,
        specifier,
      })
    );

    expect(broad).toMatchObject({
      exceededBudget: "namespace-members",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Wide",
        query: "entry299",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        members: [{ name: "entry299", spaces: ["value", "namespace"] }],
        totalMembers: 300,
      },
      status: "success",
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
          exportName,
          resolutionContext,
          specifier: selectedSpecifier,
          ...(query !== undefined && { query }),
        })
      );

      expect(outcome).toMatchObject({
        exceededBudget,
        reason: "budget-exceeded",
        status: "limit-exceeded",
      });
      expect(outcome).not.toHaveProperty("result");
    }
  );

  it.each([
    ["missing", [], "export-not-found"],
    ["Shape", ["missing"], "member-not-found"],
    ["Shape", ["secret"], "member-not-found"],
    ["Shape", ["hidden"], "member-not-found"],
    ["Shape", ["shared"], "ambiguous-member"],
  ])(
    "retains typed discovery failures for %s at %j",
    async (exportName, memberPath, reason) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("member-discovery", {
          exportName,
          memberPath,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({ reason });
      expect(outcome).not.toHaveProperty("result");
    }
  );

  it("shares qualified discovery and inspection paths in all-or-nothing plans", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        queries: [
          {
            exportName: "Shape",
            intent: "member-discovery",
            memberPath: [{ name: "nested", space: "type" }],
          },
          {
            exportName: "Shape",
            intent: "member-inspection",
            memberPath: [
              { name: "nested", space: "type" },
              { name: "leaf", space: "value" },
            ],
          },
        ],
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        inspections: [
          {
            intent: "member-discovery",
            members: [{ name: "leaf", spaces: ["value"] }],
            totalMembers: 1,
          },
          {
            declarations: [{ text: "readonly leaf: number;" }],
            intent: "member-inspection",
          },
        ],
        intent: "inspection-plan",
      },
      status: "success",
    });

    const { outcome: failed } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        queries: [
          { exportName: "Shape", intent: "member-discovery" },
          { exportName: "Wide", intent: "member-discovery" },
        ],
        resolutionContext,
        specifier,
      })
    );

    expect(failed).toMatchObject({
      exceededBudget: "member-matches",
      status: "limit-exceeded",
    });
    expect(failed).not.toHaveProperty("result");
  });

  it.each(["OversizedName", "EmptyName", "SymbolName"])(
    "rejects %s when a public name has no bounded exact selector",
    async (exportName) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("member-discovery", {
          exportName,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        reason: "unsupported-evidence",
        status: "unsupported",
      });
      expect(outcome).not.toHaveProperty("result");
    }
  );

  it("keeps string names that resemble compiler-generated symbols selectable", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "LiteralInternalName",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        members: [{ name: "__@literal", spaces: ["type"] }],
        totalMembers: 1,
      },
      status: "success",
    });

    const { outcome: selected } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        exportName: "LiteralInternalName",
        memberPath: [{ name: "__@literal", space: "type" }],
        resolutionContext,
        specifier,
      })
    );

    expect(selected).toMatchObject({
      result: { declarations: [{ text: 'readonly "__@literal": string;' }] },
      status: "success",
    });
  });

  it("accounts Member candidates across every query in an Inspection Plan", async () => {
    const queries = Array.from({ length: 7 }, () => ({
      exportName: "Wide",
      intent: "member-discovery",
      query: "entry299",
    }));

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        queries,
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      exceededBudget: "member-candidates",
      status: "limit-exceeded",
    });
    expect(outcome).not.toHaveProperty("result");
  });

  it("rejects discovery at the path-depth limit when a child selector cannot fit", async () => {
    const memberPath = Array.from({ length: 16 }, () => "next");

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Recursive",
        memberPath,
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      message:
        "Member Discovery cannot select children beyond the Member path depth limit.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });

    const { outcome: empty } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "EmptyDeep",
        memberPath,
        resolutionContext,
        specifier,
      })
    );

    expect(empty).toMatchObject({
      result: { memberPath, members: [], totalMembers: 0 },
      status: "success",
    });
  });

  it("fails explicitly when mapped public members lack declaration evidence", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Mapped",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      reason: "unsupported-evidence",
      status: "unsupported",
    });
    expect(outcome).not.toHaveProperty("result");

    const { outcome: selected } = await Effect.runPromise(
      invokeInspectionCore("member-inspection", {
        exportName: "Mapped",
        memberPath: [{ name: "foo", space: "type" }],
        resolutionContext,
        specifier,
      })
    );

    expect(selected).toMatchObject({
      reason: "no-static-representation",
      status: "unsupported",
    });
  });

  it("discovers resolved namespace reexports and selects each advertised space", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Bar",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        members: [
          { name: "Options", spaces: ["namespace"] },
          { name: "value", spaces: ["value", "namespace"] },
        ],
        totalMembers: 2,
      },
      status: "success",
    });

    if (
      outcome.status !== "success" ||
      outcome.result.intent !== "member-discovery"
    ) {
      throw new Error(JSON.stringify(outcome));
    }

    await Array.fromAsync(outcome.result.members, async (member) => {
      await Array.fromAsync(member.spaces, async (space) => {
        const { outcome: selected } = await Effect.runPromise(
          invokeInspectionCore("member-inspection", {
            exportName: "Bar",
            memberPath: [{ name: member.name, space }],
            resolutionContext,
            specifier,
          })
        );

        expect(selected).toMatchObject({
          result: { declarations: match.any(Array) },
          status: "success",
        });
      });
    });
  });

  it.each(["TypeBar", "TransitiveTypeBar", "NamedTypeBar", "TypeAndValueBar"])(
    "advertises only selectable spaces for type-only exports in %s",
    async (exportName) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("member-discovery", {
          exportName,
          resolutionContext,
          specifier,
        })
      );

      const spaces =
        exportName === "TypeAndValueBar"
          ? ["value", "namespace"]
          : ["namespace"];

      expect(outcome).toMatchObject({
        result: {
          members: [
            { name: "C", spaces },
            { name: "I", spaces: ["namespace"] },
            { name: "f", spaces },
            { name: "toString", spaces },
          ],
          totalMembers: 4,
        },
        status: "success",
      });

      if (
        outcome.status !== "success" ||
        outcome.result.intent !== "member-discovery"
      ) {
        throw new Error(JSON.stringify(outcome));
      }

      const { outcome: selected } = await Effect.runPromise(
        invokeInspectionCore("inspection-plan", {
          queries: outcome.result.members.flatMap((member) =>
            member.spaces.map((space) => ({
              exportName,
              intent: "member-inspection",
              memberPath: [{ name: member.name, space }],
            }))
          ),
          resolutionContext,
          specifier,
        })
      );

      expect(selected).toMatchObject({
        status: "success",
      });

      if (exportName !== "TypeAndValueBar") {
        await assertMissingValueMember(exportName);
      }
    }
  );

  it("bounds barrel expansion before namespace and value member lookup", async () => {
    await Array.fromAsync(["namespace", "value"] as const, async (space) => {
      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("member-inspection", {
          exportName: "BroadBarrel",
          memberPath: [{ name: "Type4096", space }],
          resolutionContext,
          specifier: `${specifier}/broad-barrel`,
        })
      );

      expect(outcome).toMatchObject({
        exceededBudget: "member-candidates",
        status: "limit-exceeded",
      });
      expect(outcome).not.toHaveProperty("result");
    });

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "BroadBarrel",
        query: "absent",
        resolutionContext,
        specifier: `${specifier}/broad-barrel`,
      })
    );

    expect(outcome).toMatchObject({
      exceededBudget: "member-candidates",
      status: "limit-exceeded",
    });
  });

  it("resolves cyclic namespace barrels without duplicating names", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("member-discovery", {
        exportName: "Cycle",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        members: [
          { name: "A", spaces: ["namespace"] },
          { name: "B", spaces: ["namespace"] },
        ],
        totalMembers: 2,
      },
      status: "success",
    });
  });
});
