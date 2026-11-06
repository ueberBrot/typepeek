import { expect, test } from "vite-plus/test";

import { comparePublicInterfaces, inspectPlan } from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";

export const registerInvocationTests = function registerInvocationTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("fails a comparison without returning a partial side", async () => {
    const outcome = await comparePublicInterfaces({
      after: {
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/focused",
      },
      before: {
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/missing-before",
      },
    });

    expect(outcome).toStrictEqual({
      message:
        'Specifier "@typepeek-fixture/missing-before" is not installed from this Resolution Context.',
      reason: "specifier-not-found",
      status: "not-found",
    });
  });

  test("returns the after failure when only the after comparison target fails", async () => {
    const outcome = await comparePublicInterfaces({
      after: {
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/missing-after",
      },
      before: {
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/focused",
      },
    });

    expect(outcome).toStrictEqual({
      message:
        'Specifier "@typepeek-fixture/missing-after" is not installed from this Resolution Context.',
      reason: "specifier-not-found",
      status: "not-found",
    });
  });

  test("returns the before failure deterministically when both comparison targets fail", async () => {
    const outcome = await comparePublicInterfaces({
      after: {
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/missing-after",
      },
      before: {
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/missing-before",
      },
    });

    expect(outcome).toStrictEqual({
      message:
        'Specifier "@typepeek-fixture/missing-before" is not installed from this Resolution Context.',
      reason: "specifier-not-found",
      status: "not-found",
    });
  });

  test("executes one atomic inspection plan over shared Installed Evidence", async () => {
    const outcome = await inspectPlan({
      queries: [
        { intent: "interface-overview" },
        { exportName: "detailed", intent: "signature-inspection" },
        { exportName: "createWidget", intent: "export-inspection" },
        { intent: "export-search", query: "error" },
        { intent: "public-subpath-discovery" },
      ],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toMatchObject({
      result: {
        inspections: [
          { intent: "interface-overview" },
          {
            intent: "signature-inspection",
            moduleExport: { name: "detailed" },
          },
          {
            intent: "export-inspection",
            moduleExport: { name: "createWidget" },
          },
          { intent: "export-search", query: "error" },
          { intent: "public-subpath-discovery" },
        ],
        intent: "inspection-plan",
      },
      status: "success",
    });
  });

  test("fails an inspection plan atomically when one selected export is missing", async () => {
    const outcome = await inspectPlan({
      queries: [
        { intent: "interface-overview" },
        { exportName: "missing", intent: "signature-inspection" },
      ],
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

  test("applies one aggregate result-construction budget to an inspection plan", async () => {
    const request = {
      accessStyle: "import",
      queries: Array.from(
        { length: 16 },
        () => ({ exportName: "inspect", intent: "export-inspection" }) as const
      ),
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/plan-aggregate-output",
    } as const;

    const expected = {
      exceededBudget: "result-construction",
      message: "Inspection exceeded its output limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    } as const;

    await expect(inspectPlan(request)).resolves.toStrictEqual(expected);
  });

  test("applies one aggregate Member type traversal budget to an inspection plan", async () => {
    const outcome = await inspectPlan({
      queries: Array.from(
        { length: 16 },
        (_, index) =>
          ({
            exportName: `PlanMemberTypeBudget${index}`,
            intent: "export-inspection",
          }) as const
      ),
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/focused",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "supporting-type-traversal",
      message: "Inspection exceeded its Supporting Type traversal limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("applies one aggregate inferred declaration budget to an inspection plan", async () => {
    const outcome = await inspectPlan({
      queries: Array.from(
        { length: 16 },
        (_, index) =>
          ({
            exportName: `inferredPlanBudget${index}`,
            intent: "declaration-inspection",
          }) as const
      ),
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/private-constructor-source",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "supporting-type-traversal",
      message: "Inspection exceeded its Supporting Type traversal limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });
};
