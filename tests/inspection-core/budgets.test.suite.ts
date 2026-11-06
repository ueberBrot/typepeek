import { expect, test } from "vite-plus/test";

import {
  inspectExport,
  inspectExportMember,
  inspectExportSignatures,
  inspectInterfaceOverview,
} from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerBudgetTests = function registerBudgetTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("fails explicitly when Package Documentation exceeds its bound", async () => {
    const outcome = await inspectExport({
      exportName: "documented",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/oversized-docs",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "package-documentation",
      message: "Inspection exceeded its Package Documentation limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("fails explicitly when Supporting Type traversal exceeds its breadth bound", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-supporting-types",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "supporting-types",
      message: "Inspection exceeded its Supporting Type limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("fails explicitly when Supporting Type traversal exceeds its depth bound", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/deep-supporting-types",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "supporting-type-depth",
      message: "Inspection exceeded its Supporting Type depth limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("fails explicitly when an anonymous Public Interface type exceeds traversal depth", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/deep-anonymous-type",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "supporting-type-traversal",
      message: "Inspection exceeded its Supporting Type traversal limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("fails explicitly before bounded result parts multiply into oversized aggregate output", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/aggregate-output",
    });

    const expected = {
      exceededBudget: "result-construction",
      message: "Inspection exceeded its output limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    } as const;

    expect(outcome).toStrictEqual(expected);
  });

  test("accounts for namespace containers before aggregate output crosses its construction bound", async () => {
    const request = {
      accessStyle: "import",
      exportName: "Root",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/aggregate-namespace-alias",
    } as const;

    const expected = {
      exceededBudget: "result-construction",
      message: "Inspection exceeded its output limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    } as const;

    await expect(inspectExport(request)).resolves.toStrictEqual(expected);
  });

  test("fails explicitly when overload rendering exceeds its bound", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-overloads",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "signatures",
      message: "Inspection exceeded its Module Export signature limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("fails explicitly when one rendered signature exceeds its byte bound", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/wide-signature",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "signature-bytes",
      message: "Inspection exceeded its Module Export signature byte limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("bounds detailed parameters without shrinking the compact Export Inspection", async () => {
    const request = {
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-parameters",
    };

    const [focused, signatures] = await Promise.all([
      inspectExport(request),
      inspectExportSignatures(request),
    ]);

    expect([focused.status, signatures]).toStrictEqual([
      "success",
      {
        exceededBudget: "signature-parameters",
        message: "Inspection exceeded its signature parameter limit.",
        reason: "budget-exceeded",
        status: "limit-exceeded",
      },
    ]);
  });

  test("bounds detailed type parameters without shrinking the compact Export Inspection", async () => {
    const request = {
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/broad-type-parameters",
    };

    const [focused, signatures] = await Promise.all([
      inspectExport(request),
      inspectExportSignatures(request),
    ]);

    expect([focused.status, signatures]).toStrictEqual([
      "success",
      {
        exceededBudget: "signature-type-parameters",
        message: "Inspection exceeded its signature type parameter limit.",
        reason: "budget-exceeded",
        status: "limit-exceeded",
      },
    ]);
  });

  test("bounds one detailed signature by its serialized size", async () => {
    const request = {
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/detailed-wide-signature",
    };

    const [focused, signatures] = await Promise.all([
      inspectExport(request),
      inspectExportSignatures(request),
    ]);

    expect([focused.status, signatures]).toStrictEqual([
      "success",
      {
        exceededBudget: "signature-bytes",
        message: "Inspection exceeded its Module Export signature byte limit.",
        reason: "budget-exceeded",
        status: "limit-exceeded",
      },
    ]);
  });

  test("bounds the aggregate serialized size of detailed signatures", async () => {
    const request = {
      exportName: "inspect",
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/detailed-wide-overloads",
    };

    const [focused, signatures] = await Promise.all([
      inspectExport(request),
      inspectExportSignatures(request),
    ]);

    expect([focused.status, signatures]).toStrictEqual([
      "success",
      {
        exceededBudget: "signature-bytes",
        message: "Inspection exceeded its Module Export signature byte limit.",
        reason: "budget-exceeded",
        status: "limit-exceeded",
      },
    ]);
  });

  test("fails explicitly when compiler resolution exhausts its filesystem work budget", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/failed-lookup-storm",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "compiler-host-work",
      message: "Inspection exceeded its compiler host work limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("fails explicitly when duplicate path references exhaust compiler work", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/duplicate-path-references",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "compiler-host-work",
      message: "Inspection exceeded its compiler host work limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test.each([
    [
      "declaration files",
      "@typepeek-fixture/broad-declaration-files",
      "declaration-files",
      "Inspection exceeded its declaration file limit.",
    ],
    [
      "declaration source bytes",
      "@typepeek-fixture/oversized-declaration-source",
      "declaration-bytes",
      "Inspection exceeded its declaration byte limit.",
    ],
    [
      "package manifest bytes",
      "@typepeek-fixture/oversized-manifest",
      "package-manifest-bytes",
      "Inspection exceeded its package manifest size limit.",
    ],
    [
      "compiler resolution bytes",
      "@typepeek-fixture/oversized-resolution",
      "compiler-host-bytes",
      "Inspection exceeded its compiler host byte limit.",
    ],
  ])(
    "fails explicitly when $name exceed their installed-evidence budget",
    async (_name, specifier, exceededBudget, message) => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier,
      });

      expect(outcome).toStrictEqual({
        exceededBudget,
        message,
        reason: "budget-exceeded",
        status: "limit-exceeded",
      });
    }
  );

  test.each([
    [
      "merged declarations",
      "@typepeek-fixture/merged-declarations",
      "Merged",
      "merged-declarations",
      "Inspection exceeded its declaration merge limit.",
    ],
    [
      "namespace members",
      "@typepeek-fixture/broad-namespace",
      "Broad",
      "namespace-members",
      "Inspection exceeded its namespace member limit.",
    ],
    [
      "namespace depth",
      "@typepeek-fixture/deep-namespace",
      "Deep",
      "namespace-depth",
      "Inspection exceeded its namespace traversal depth limit.",
    ],
  ])(
    "fails explicitly when $name exceed their result budget",
    async (_name, specifier, exportName, exceededBudget, message) => {
      const outcome = await inspectExport({
        exportName,
        resolutionContext: getFixture().resolutionContext,
        specifier,
      });

      expect(outcome).toStrictEqual({
        exceededBudget,
        message,
        reason: "budget-exceeded",
        status: "limit-exceeded",
      });
    }
  );

  test("bounds nested namespace projection during Member Inspection", async () => {
    const outcome = await inspectExportMember({
      exportName: "Root",
      memberPath: ["Selected"],
      resolutionContext: getFixture().resolutionContext,
      specifier: "@typepeek-fixture/deep-member-namespace",
    });

    expect(outcome).toStrictEqual({
      exceededBudget: "supporting-type-traversal",
      message: "Inspection exceeded its Supporting Type traversal limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });

  test("returns deterministic unchanged evidence before and after hostile bounded inspections", async () => {
    const inspectStableExport = async () =>
      await inspectExport({
        exportName: "createWidget",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/focused",
      });

    const baseline = await inspectStableExport();
    await Promise.all([
      inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/failed-lookup-storm",
      }),
      inspectExport({
        exportName: "inspect",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/aggregate-output",
      }),
    ]);

    const sequential = await Array.fromAsync(
      { length: 4 },
      inspectStableExport
    );

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, inspectStableExport)
    );

    expect([baseline, [...sequential, ...concurrent]]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      Array.from({ length: 8 }, () => baseline),
    ]);
  });
};
