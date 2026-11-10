import { expect, test } from "vite-plus/test";

import { inspectExport } from "#typepeek/inspection";
import { requireDefined } from "#typepeek/shared/defined-value";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";

export const registerSupportingTypeTests = function registerSupportingTypeTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("keeps JSDoc tags as bounded untrusted Package Documentation", async () => {
    const outcome = await inspectExport({
      exportName: "deprecatedOnly",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        packageDocumentation: {
          provenance: "installed-evidence",
          text: "@deprecated Use inspectInline instead.",
          trust: "untrusted",
        },
      },
      status: "success",
    });
  });

  test("follows Supporting Types referenced through inline import types", async () => {
    const outcome = await inspectExport({
      exportName: "inspectInline",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.supportingTypes.map(({ name }) => name)
    ).toStrictEqual(["InlineInput", "InlineOutput"]);
  });

  test("follows value declarations and their shapes referenced through typeof", async () => {
    const outcome = await inspectExport({
      exportName: "Defaults",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.supportingTypes.map(({ name, declarations }) => ({
        declarationKinds: declarations.map(({ kind }) => kind),
        name,
      }))
    ).toStrictEqual([
      { declarationKinds: ["variable"], name: "defaults" },
      { declarationKinds: ["interface"], name: "DefaultOptions" },
    ]);
  });

  test("follows a referenced Member's type without representing the Member as a Supporting Type", async () => {
    const outcome = await inspectExport({
      exportName: "MemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.supportingTypes.map(({ name }) => name)
    ).toStrictEqual(["MemberTypeValue"]);
  });

  test("bounds Supporting Type traversal reached through a Member", async () => {
    const outcome = await inspectExport({
      exportName: "DeepMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      message: "Inspection exceeded its Supporting Type depth limit.",
      status: "limit-exceeded",
    });
  });

  test("does not represent a namespace Member value declaration as a Supporting Type", async () => {
    const outcome = await inspectExport({
      exportName: "NamespaceMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.supportingTypes.map(({ name }) => name)
    ).toStrictEqual(["MemberTypeValue"]);
  });

  test("serializes a literal Member type into the authoritative declaration", async () => {
    const outcome = await inspectExport({
      exportName: "LiteralMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect(declaration).toBe("type LiteralMemberTypeQuery = 200;");
  });

  test("serializes an anonymous Member type into the authoritative declaration", async () => {
    const outcome = await inspectExport({
      exportName: "AnonymousMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect([
      requireDefined(declaration).includes("readonly enabled: true;"),
      requireDefined(declaration).includes("typeQueryContainer"),
    ]).toStrictEqual([true, false]);
  });

  test("preserves a safe standard-library query reached through a Member", async () => {
    const outcome = await inspectExport({
      exportName: "StandardLibraryMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect([declaration, outcome.result.supportingTypes]).toStrictEqual([
      "type StandardLibraryMemberTypeQuery = typeof Symbol.iterator;",
      [],
    ]);
  });

  test("projects a package-local Symbol member instead of trusting its spelling", async () => {
    const outcome = await inspectExport({
      exportName: "ShadowedSymbolMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect([
      requireDefined(declaration).includes(
        "export type Result = ShadowedSymbolSecret;"
      ),
      requireDefined(declaration).includes("typeof Symbol.iterator"),
      outcome.result.supportingTypes.map(({ name }) => name),
    ]).toStrictEqual([true, false, ["ShadowedSymbolSecret"]]);
  });

  test("projects a declaration-less synthetic Member type", async () => {
    const outcome = await inspectExport({
      exportName: "SyntheticMappedMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect([
      declaration,
      outcome.result.supportingTypes.map(({ name }) => name),
    ]).toStrictEqual([
      "type SyntheticMappedMemberTypeQuery = MemberTypeValue;",
      ["MemberTypeValue"],
    ]);
  });

  test("projects a private namespace-import Member type", async () => {
    const outcome = await inspectExport({
      exportName: "ImportedNamespaceMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect([
      requireDefined(declaration).includes("typeof InternalMemberTypes.value"),
      outcome.result.supportingTypes
        .map(({ name }) => name)
        .includes("ImportedMemberType"),
    ]).toStrictEqual([false, true]);
  });

  test.each([
    ["AnyMemberTypeQuery", "any"],
    ["UnknownMemberTypeQuery", "unknown"],
    ["EmptyMemberTypeQuery", "{}"],
  ] as const)(
    "serializes the exact %s Member type",
    async (exportName, expectedType) => {
      const outcome = await inspectExport({
        exportName,
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/focused",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
        "declarations" in space ? space.declarations : []
      )[0]?.text;

      expect(declaration).toBe(`type ${exportName} = ${expectedType};`);
    }
  );

  test("serializes an unqualified private namespace Member type", async () => {
    const outcome = await inspectExport({
      exportName: "UnqualifiedMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    const declaration = outcome.result.moduleExport.spaces.flatMap((space) =>
      "declarations" in space ? space.declarations : []
    )[0]?.text;

    expect([
      /export type Result = \{\s+readonly enabled: true;\s+\};/u.test(
        requireDefined(declaration)
      ),
      requireDefined(declaration).includes("typeof local"),
      requireDefined(declaration).includes("const local"),
    ]).toStrictEqual([true, false, false]);
  });

  test("rejects a merged namespace class Member type that cannot be represented independently", async () => {
    const outcome = await inspectExport({
      exportName: "NamespaceClassMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      message: "A Member type query could not be represented independently.",
      status: "unsupported",
    });
  });

  test("rejects a nested namespace enum Member type that cannot be represented independently", async () => {
    const outcome = await inspectExport({
      exportName: "NamespaceEnumMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      message: "A Member type query could not be represented independently.",
      status: "unsupported",
    });
  });

  test("retains a standalone class reached through a Member type query", async () => {
    const outcome = await inspectExport({
      exportName: "StandaloneClassMemberTypeQuery",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.supportingTypes.map(({ name }) => name)
    ).toStrictEqual(["StandaloneMemberClass", "MemberTypeValue"]);
  });

  test("preserves nested namespace ownership", async () => {
    const outcome = await inspectExport({
      exportName: "tools",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/alias-forms",
    });

    expect(outcome.status).toBe("success");

    if (outcome.status !== "success") {
      return;
    }

    expect(
      outcome.result.moduleExport.spaces.find(
        ({ space }) => space === "namespace"
      )
    ).toMatchObject({
      members: [
        {
          declarations: [{ kind: "function" }],
          members: [],
          name: "useTool",
        },
        {
          declarations: [{ kind: "alias" }],
          members: [
            {
              declarations: [{ kind: "interface" }],
              members: [],
              name: "NestedInput",
            },
            {
              declarations: [{ kind: "function" }],
              members: [],
              name: "useNested",
            },
          ],
          name: "nested",
        },
      ],
      space: "namespace",
    });
  });
};
