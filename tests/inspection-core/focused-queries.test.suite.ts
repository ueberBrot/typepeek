import { expect, test } from "vite-plus/test";

import {
  inspectExport,
  inspectExportDeclarations,
  inspectExportMember,
  inspectExportSearch,
  inspectPlan,
  inspectPublicSubpaths,
} from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerFocusedQueryTests = function registerFocusedQueryTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("searches Module Export names without returning a complete Interface Overview", async () => {
    const outcome = await inspectExportSearch({
      query: "error",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        intent: "export-search",
        matches: [
          { name: "ErrorFactory" },
          { name: "InheritedError" },
          { name: "TransitiveError" },
        ],
        query: "error",
      },
      status: "success",
    });

    if (outcome.status !== "success") {
      throw new Error("Expected a successful inspection.");
    }

    expect(outcome.result.totalModuleExports).toBeGreaterThan(
      outcome.result.matches.length
    );
  });

  test("searches a broad Module Export index that exceeds the overview limit", async () => {
    const outcome = await inspectExportSearch({
      query: "item320",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad",
    });

    expect(outcome).toMatchObject({
      result: {
        matches: [{ name: "item320" }],
        totalModuleExports: 321,
      },
      status: "success",
    });
  });

  test("discovers Public Subpaths without materializing a TypeScript program", async () => {
    const outcome = await inspectPublicSubpaths({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/conditional",
    });

    expect(outcome).toMatchObject({
      result: {
        intent: "public-subpath-discovery",
        publicSubpaths: [
          { specifier: "@typepeek-fixture/conditional/feature" },
          { specifier: "@typepeek-fixture/conditional/nested/feature" },
          { specifier: "@typepeek-fixture/conditional/patterns/red" },
        ],
      },
      status: "success",
    });
  });

  test("inspects only the declaration surface of one Module Export", async () => {
    const outcome = await inspectExportDeclarations({
      exportName: "createWidget",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        intent: "declaration-inspection",
        moduleExport: {
          name: "createWidget",
          spaces: [{ space: "value" }, { space: "namespace" }],
        },
      },
      status: "success",
    });

    if (outcome.status !== "success") {
      throw new Error("Expected a successful inspection result.");
    }

    expect(outcome.result).not.toHaveProperty("supportingTypes");
    expect(outcome.result.moduleExport).not.toHaveProperty("signatures");
  });

  test("inspects declarations without consuming the Supporting Type traversal budget", async () => {
    const outcome = await inspectExportDeclarations({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/deep-supporting-types",
    });

    expect(outcome).toMatchObject({
      result: {
        intent: "declaration-inspection",
        moduleExport: { name: "inspect" },
      },
      status: "success",
    });
  });

  test("inspects one exact public member without traversing the complete export", async () => {
    const outcome = await inspectExportMember({
      exportName: "PublicShape",
      memberPath: ["visible"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        declarations: [
          { kind: "property", text: "readonly visible: VisibleOnly;" },
        ],
        intent: "member-inspection",
        memberPath: ["visible"],
        moduleExportName: "PublicShape",
      },
      status: "success",
    });
  });

  test("removes source method implementation from Member Inspection", async () => {
    const outcome = await inspectExportMember({
      exportName: "SourceMembers",
      memberPath: ["send"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/private-constructor-source",
    });

    expect(outcome).toMatchObject({
      result: {
        declarations: [
          { kind: "method", text: "send(prefix?: string): string;" },
        ],
        intent: "member-inspection",
        memberPath: ["send"],
        moduleExportName: "SourceMembers",
      },
      status: "success",
    });
  });

  test.each([
    ["count", [{ kind: "property", text: "count: number;" }]],
    ["mode", [{ kind: "property", text: 'readonly mode: "public";' }]],
    [
      "label",
      [
        { kind: "accessor", text: "get label(): string;" },
        { kind: "accessor", text: "set label(value: string);" },
      ],
    ],
    [
      "run",
      [
        { kind: "method", text: "run(value: string): string;" },
        { kind: "method", text: "run(value: number): number;" },
      ],
    ],
  ] as const)(
    "preserves only the public declaration of source Member %s",
    async (member, declarations) => {
      const outcome = await inspectExportMember({
        exportName: "SourceMembers",
        memberPath: [member],
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome).toMatchObject({
        result: { declarations },
        status: "success",
      });
    }
  );

  test.each([
    ["Constant", "Constant = 3"],
    ["Computed", "Computed"],
  ])(
    "projects source enum Member %s without initializer implementation",
    async (member, text) => {
      const outcome = await inspectExportMember({
        exportName: "SourceValues",
        memberPath: [member],
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome).toMatchObject({
        result: { declarations: [{ kind: "enum-member", text }] },
        status: "success",
      });
    }
  );

  test("does not expose a private member through focused Member Inspection", async () => {
    const outcome = await inspectExportMember({
      exportName: "PublicShape",
      memberPath: ["secret"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toStrictEqual({
      message:
        'Public Member "PublicShape.secret" was not found in "@typepeek-fixture/focused".',
      reason: "member-not-found",
      status: "not-found",
    });
  });

  test("does not expose a protected member through focused Member Inspection", async () => {
    const outcome = await inspectExportMember({
      exportName: "PublicShape",
      memberPath: ["inherited"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toStrictEqual({
      message:
        'Public Member "PublicShape.inherited" was not found in "@typepeek-fixture/focused".',
      reason: "member-not-found",
      status: "not-found",
    });
  });

  test("inspects an exact enum Member", async () => {
    const outcome = await inspectExportMember({
      exportName: "PublicValues",
      memberPath: ["First"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        declarations: [
          { kind: "enum-member", text: match.stringContaining("First") },
        ],
        intent: "member-inspection",
        memberPath: ["First"],
        moduleExportName: "PublicValues",
      },
      status: "success",
    });
  });

  test("rejects a Member path that is ambiguous across declaration spaces", async () => {
    const outcome = await inspectExportMember({
      exportName: "AmbiguousShape",
      memberPath: ["shared"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toStrictEqual({
      message:
        'Public Member "AmbiguousShape.shared" is ambiguous across declaration spaces.',
      reason: "ambiguous-member",
      status: "unsupported",
    });
  });

  test("returns unsupported rather than not-found for source-backed inferred object members", async () => {
    const outcome = await inspectExportMember({
      exportName: "inferredObject",
      memberPath: ["visible"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/private-constructor-source",
    });

    expect(outcome).toStrictEqual({
      message:
        'Public Member "inferredObject.visible" has no declaration-safe static representation.',
      reason: "no-static-representation",
      status: "unsupported",
    });
  });

  test.each([
    ["InferredArrayMember", "type InferredArrayMember = number[];"],
    ["InferredPromiseMember", "type InferredPromiseMember = Promise<number>;"],
  ])(
    "preserves the standard-library type of source-inferred Member %s",
    async (exportName, declaration) => {
      const outcome = await inspectExport({
        exportName,
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome).toMatchObject({
        result: {
          moduleExport: {
            spaces: [{ declarations: [{ text: declaration }], space: "type" }],
          },
        },
        status: "success",
      });
    }
  );

  test("looks up one namespace Member directly without consuming unrelated breadth", async () => {
    const outcome = await inspectExportMember({
      exportName: "Broad",
      memberPath: ["value128"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-namespace",
    });

    expect(outcome).toMatchObject({
      result: {
        declarations: [{ kind: "variable" }],
        intent: "member-inspection",
        memberPath: ["value128"],
        moduleExportName: "Broad",
      },
      status: "success",
    });
  });

  test("resolves each segment of an exact nested Member path", async () => {
    const outcome = await inspectExportMember({
      exportName: "NestedShape",
      memberPath: ["nested", "leaf"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        declarations: [
          { kind: "property", text: "readonly leaf: VisibleOnly;" },
        ],
        intent: "member-inspection",
        memberPath: ["nested", "leaf"],
        moduleExportName: "NestedShape",
      },
      status: "success",
    });
  });

  test("enforces the merged-declaration bound before resolving an intermediate Member path", async () => {
    const outcome = await inspectExportMember({
      exportName: "Merged",
      memberPath: ["value0"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/merged-declarations",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "merged-declarations",
      message: "Inspection exceeded its declaration merge limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("executes declaration and member queries atomically in an Inspection Plan", async () => {
    const outcome = await inspectPlan({
      queries: [
        { exportName: "createWidget", intent: "declaration-inspection" },
        {
          exportName: "PublicShape",
          intent: "member-inspection",
          memberPath: ["visible"],
        },
      ],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        inspections: [
          {
            intent: "declaration-inspection",
            moduleExport: { name: "createWidget" },
          },
          {
            intent: "member-inspection",
            memberPath: ["visible"],
            moduleExportName: "PublicShape",
          },
        ],
        intent: "inspection-plan",
      },
      status: "success",
    });
  });
};
