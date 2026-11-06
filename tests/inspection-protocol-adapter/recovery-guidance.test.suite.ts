import { expect, test } from "vite-plus/test";

import {
  INSPECTION_PROTOCOL_VERSION,
  inspectExport,
  invokeInspectionProtocol,
} from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerRecoveryGuidanceTests =
  function registerRecoveryGuidanceTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("returns executable narrower requests after Supporting Type exhaustion", async () => {
      const response = await invokeInspectionProtocol({
        intent: "export-inspection",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          exportName: "inspect",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/deep-supporting-types",
        },
      });

      expect(response).toMatchObject({
        outcome: {
          exceededBudget: "supporting-type-depth",
          status: "limit-exceeded",
        },
        recovery: [
          {
            reason: "inspect-declarations-without-supporting-types",
            request: {
              intent: "declaration-inspection",
              protocolVersion: "1",
              request: {
                accessStyle: "import",
                exportName: "inspect",
                resolutionContext: getFixture().resolutionContext,
                specifier: "@typepeek-fixture/deep-supporting-types",
              },
            },
          },
          {
            reason: "inspect-signatures-without-supporting-types",
            request: {
              intent: "signature-inspection",
              protocolVersion: "1",
              response: { signatureEvidence: "structured" },
            },
          },
        ],
      });
      const suggested = response.recovery?.[1]?.request;
      const recovered = await invokeInspectionProtocol(suggested);
      expect(recovered).toMatchObject({
        outcome: {
          result: { intent: "signature-inspection" },
          status: "success",
        },
      });
    });

    test("returns an executable non-empty Export Search after an exact export miss", async () => {
      const response = await invokeInspectionProtocol({
        intent: "signature-inspection",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          exportName: "WidgetF",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      });

      expect(response).toMatchObject({
        outcome: { reason: "export-not-found", status: "not-found" },
        recovery: [
          {
            reason: "search-related-export-names",
            request: {
              intent: "export-search",
              protocolVersion: "1",
              request: { query: "WidgetF" },
            },
          },
        ],
      });

      const recovered = await invokeInspectionProtocol(
        response.recovery?.[0]?.request
      );

      expect(recovered).toMatchObject({
        outcome: {
          result: {
            intent: "export-search",
            matches: match.arrayContaining([{ name: "WidgetFactory" }]),
          },
          status: "success",
        },
      });
    });

    test("returns executable Export Search recovery after a Member Inspection export miss", async () => {
      const response = await invokeInspectionProtocol({
        intent: "member-inspection",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          exportName: "WidgetF",
          memberPath: ["create"],
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      });

      const recovered = await invokeInspectionProtocol(
        response.recovery?.[0]?.request
      );

      expect(recovered).toMatchObject({
        outcome: {
          result: {
            intent: "export-search",
            matches: match.arrayContaining([{ name: "WidgetFactory" }]),
          },
          status: "success",
        },
      });
    });

    test("omits Export Search recovery when the missing export cannot be a valid query", async () => {
      const response = await invokeInspectionProtocol({
        intent: "signature-inspection",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          exportName: "x".repeat(257),
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      });

      expect([response, response.recovery === undefined]).toStrictEqual([
        match.objectContaining({
          outcome: match.objectContaining({
            reason: "export-not-found",
            status: "not-found",
          }),
        }),
        true,
      ]);
    });

    test("returns machine-readable reasons and exceeded budget dimensions", async () => {
      await expect(
        inspectExport({
          exportName: "missing",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        })
      ).resolves.toStrictEqual({
        message:
          'Module Export "missing" was not found in "@typepeek-fixture/focused".',
        reason: "export-not-found",
        status: "not-found",
      });
      await expect(
        invokeInspectionProtocol({
          intent: "interface-overview",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/broad",
          },
        })
      ).resolves.toStrictEqual({
        outcome: {
          exceededBudget: "module-exports",
          message: "Inspection exceeded its Module Export limit.",
          reason: "budget-exceeded",
          status: "limit-exceeded",
        },
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
      });
    });
  };
