import { Function as Fn, Result, Schema } from "effect";
import { expect, test } from "vite-plus/test";

import {
  INSPECTION_PROTOCOL_VERSION,
  comparePublicInterfaces,
  invokeInspectionProtocol,
} from "#typepeek/inspection";
import {
  inspectionProtocolRequestSchema,
  inspectionProtocolResponseSchema,
} from "#typepeek/inspection/inspection-protocol-schema";
import { protocolRecoveryGuidance } from "#typepeek/inspection/protocol-recovery";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerResponseContractTests =
  function registerResponseContractTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("uses executable schemas as authority for correlated requests and complete responses", async () => {
      const request = {
        intent: "signature-inspection",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          exportName: "createWidget",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
        response: { signatureEvidence: "exact" },
      } as const;

      const response = await invokeInspectionProtocol(request);
      expect([
        Result.isSuccess(
          Schema.decodeResult(inspectionProtocolRequestSchema)(request)
        ),
        Result.isSuccess(
          Schema.decodeResult(inspectionProtocolResponseSchema)(response)
        ),
        Result.isFailure(
          Schema.decodeUnknownResult(inspectionProtocolRequestSchema)({
            ...request,
            intent: "interface-overview",
          })
        ),
      ]).toStrictEqual([true, true, true]);
    });

    test("rejects protocol response combinations the dispatcher cannot emit", async () => {
      const signatureResponse = await invokeInspectionProtocol({
        intent: "signature-inspection",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          exportName: "createWidget",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
        response: { signatureEvidence: "exact" },
      });

      const overviewResponse = await invokeInspectionProtocol({
        intent: "interface-overview",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      });

      const unprojectedSignatureResponse = { ...signatureResponse };
      Reflect.deleteProperty(unprojectedSignatureResponse, "projection");

      expect([
        Result.isFailure(
          Schema.decodeResult(inspectionProtocolResponseSchema)(
            unprojectedSignatureResponse
          )
        ),
        Result.isFailure(
          Schema.decodeUnknownResult(inspectionProtocolResponseSchema)({
            ...overviewResponse,
            projection: {
              omittedEvidence: ["structured-signature-fields"],
              signatureEvidence: "exact",
            },
          })
        ),
      ]).toStrictEqual([true, true]);
    });

    test("correlates and bounds executable recovery guidance", async () => {
      const successfulResponse = await invokeInspectionProtocol({
        intent: "interface-overview",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      });

      const guidance = {
        reason: "search-related-export-names",
        request: {
          intent: "export-search",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {
            query: "Widget",
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
        },
      } as const;

      const searchFailureResponse = {
        outcome: {
          message: "The requested export was not found.",
          reason: "export-not-found",
          status: "not-found",
        },
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
      } as const;

      const accepts = Fn.flow(
        Schema.decodeUnknownResult(inspectionProtocolResponseSchema),
        Result.isSuccess
      );

      const rejects = (recovery: readonly unknown[]) =>
        Result.isFailure(
          Schema.decodeUnknownResult(inspectionProtocolResponseSchema)({
            ...searchFailureResponse,
            recovery,
          })
        );

      expect([
        accepts({ ...successfulResponse, recovery: [guidance] }),
        accepts({ ...searchFailureResponse, recovery: [guidance] }),
        rejects([
          {
            ...guidance,
            reason: "inspect-declarations-without-supporting-types",
          },
        ]),
        rejects([guidance, guidance, guidance, guidance]),
        rejects([
          {
            ...guidance,
            request: {
              ...guidance.request,
              request: {
                ...guidance.request.request,
                resolutionContext: `/${"x".repeat(33 * 1024)}`,
              },
            },
          },
        ]),
      ]).toStrictEqual([false, true, true, true, true]);
    });

    test("omits an over-budget supporting-type recovery pair atomically", () => {
      const guidance = protocolRecoveryGuidance(
        {
          intent: "export-inspection",
          request: {
            accessStyle: "import",
            exportName: "x".repeat(16_160),
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/deep-supporting-types",
          },
        },
        {
          exceededBudget: "supporting-type-depth",
          message: "Supporting Type traversal exceeded its depth budget.",
          reason: "budget-exceeded",
          status: "limit-exceeded",
        }
      );

      expect(guidance).toStrictEqual([]);
    });

    test("rejects an explicitly undefined response property", async () => {
      await expect(
        invokeInspectionProtocol({
          intent: "interface-overview",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/command-signatures",
          },
          ...Object.fromEntries([["response", undefined]]),
        })
      ).resolves.toMatchObject({ outcome: { reason: "invalid-request" } });
    });

    test("dispatches Public Interface comparison through the Inspection Protocol", async () => {
      const request = {
        after: {
          accessStyle: "require",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/conditional",
        },
        before: {
          accessStyle: "import",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/conditional",
        },
      } as const;

      const direct = await comparePublicInterfaces(request);
      await expect(
        invokeInspectionProtocol({
          intent: "public-interface-comparison",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request,
        })
      ).resolves.toStrictEqual({
        outcome: direct,
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
      });
    });

    test.each([
      {
        ...Object.fromEntries([["evidence", undefined]]),
        expectedEvidence: "structured",
        expectedKeys: ["kind", "typeParameters", "parameters", "returns"],
        omittedKey: "text",
      },
      {
        evidence: "structured",
        expectedEvidence: "structured",
        expectedKeys: ["kind", "typeParameters", "parameters", "returns"],
        omittedKey: "text",
      },
      {
        evidence: "exact",
        expectedEvidence: "exact",
        expectedKeys: ["kind", "text"],
        omittedKey: "parameters",
      },
      {
        evidence: "both",
        expectedEvidence: "both",
        expectedKeys: [
          "kind",
          "text",
          "typeParameters",
          "parameters",
          "returns",
        ],
        ...Object.fromEntries([["omittedKey", undefined]]),
      },
    ] as const)(
      "projects $expectedEvidence Signature Evidence without changing Inspection Core",
      async ({ evidence, expectedEvidence, expectedKeys, omittedKey }) => {
        const response = await invokeInspectionProtocol({
          intent: "signature-inspection",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {
            exportName: "createWidget",
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
          ...(evidence !== undefined && {
            response: { signatureEvidence: evidence },
          }),
        });

        expect(response).toMatchObject({
          outcome: {
            result: { intent: "signature-inspection" },
            status: "success",
          },
          projection: { signatureEvidence: expectedEvidence },
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
        });

        if (response.outcome.status !== "success") {
          return;
        }

        const { result } = response.outcome;

        if (result.intent !== "signature-inspection") {
          return;
        }

        const [signature] = result.moduleExport.signatures;
        expect(Object.keys(signature ?? {})).toStrictEqual(
          match.arrayContaining([...expectedKeys])
        );

        expect(
          omittedKey === undefined ||
            !Object.hasOwn(signature ?? {}, omittedKey)
        ).toBeTruthy();
      }
    );

    test("applies Signature Evidence projection to Signature Inspections inside a plan", async () => {
      const response = await invokeInspectionProtocol({
        intent: "inspection-plan",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          queries: [
            { exportName: "createWidget", intent: "signature-inspection" },
          ],
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      });

      expect([
        response,
        JSON.stringify(response).includes('"text":'),
      ]).toStrictEqual([
        match.objectContaining({
          outcome: match.objectContaining({
            result: match.objectContaining({
              inspections: [
                match.objectContaining({ intent: "signature-inspection" }),
              ],
              intent: "inspection-plan",
            }),
            status: "success",
          }),
          projection: match.objectContaining({
            signatureEvidence: "structured",
          }),
        }),
        false,
      ]);
    });

    test("rejects Signature Evidence projection for unrelated intents", async () => {
      await expect(
        invokeInspectionProtocol({
          intent: "interface-overview",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
          response: { signatureEvidence: "structured" },
        })
      ).resolves.toMatchObject({
        outcome: { reason: "invalid-request", status: "unsupported" },
      });
    });

    test("accepts Signature Evidence projection as a no-op for plans without signatures", async () => {
      const response = await invokeInspectionProtocol({
        intent: "inspection-plan",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          queries: [{ intent: "interface-overview" }],
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
        response: { signatureEvidence: "exact" },
      });

      expect(response).toMatchObject({
        outcome: {
          result: {
            inspections: [{ intent: "interface-overview" }],
            intent: "inspection-plan",
          },
          status: "success",
        },
        projection: { signatureEvidence: "exact" },
      });
    });
  };
