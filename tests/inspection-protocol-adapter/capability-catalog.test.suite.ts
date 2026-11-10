import { Result, Schema } from "effect";
import { expect, test } from "vite-plus/test";

import type { InspectionIntent } from "#typepeek/inspection";
import {
  INSPECTION_PROTOCOL_VERSION,
  inspectCapabilities,
  inspectionCapabilitiesSchema,
  invokeInspectionProtocol,
} from "#typepeek/inspection";
import { withRequestFieldCapability } from "#typepeek/inspection/model/request-capability";
import { isJsonObject } from "#typepeek/shared/json-data";

import { match } from "../helpers/matchers.ts";

const targetInCurrentResolutionContext =
  function targetInCurrentResolutionContext(value: Schema.Json | undefined) {
    if (!isJsonObject(value)) {
      throw new Error("A request example must contain an object target.");
    }

    return {
      ...Object.fromEntries(Object.entries(value)),
      resolutionContext: process.cwd(),
    };
  };

const exampleInCurrentResolutionContext =
  function exampleInCurrentResolutionContext(
    intent: InspectionIntent,
    example: ReturnType<
      typeof inspectCapabilities
    >["requestDescriptors"][number]["example"]
  ) {
    const record = Schema.decodeUnknownSync(Schema.JsonObject)(example);

    if (intent === "public-interface-comparison") {
      return {
        after: targetInCurrentResolutionContext(record["after"]),
        before: targetInCurrentResolutionContext(record["before"]),
      };
    }

    return { ...record, resolutionContext: process.cwd() };
  };

export const registerCapabilityCatalogTests =
  function registerCapabilityCatalogTests(): void {
    test("publishes deterministic adapter capabilities without TypeScript enums", () => {
      expect(inspectCapabilities()).toMatchObject({
        budgetDimensions: match.arrayContaining([
          "request-bytes",
          "analysis-deadline",
          "analysis-memory",
          "analysis-output-bytes",
          "result-construction",
          "module-exports",
          "merged-declarations",
        ]),
        failureReasons: [
          "specifier-not-found",
          "export-not-found",
          "member-not-found",
          "invalid-request",
          "invalid-result",
          "unsupported-protocol-version",
          "ambiguous-member",
          "no-static-representation",
          "unsupported-evidence",
          "analysis-terminated",
          "static-boundary",
          "budget-exceeded",
        ],
        intent: "capabilities",
        limits: {
          maxRecoveryBytes: 32 * 1024,
          maxRecoveryEntries: 2,
          maxSerializedBytes: 16_384,
        },
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        recoveryReasons: [
          "inspect-declarations-without-supporting-types",
          "inspect-signatures-without-supporting-types",
          "search-related-export-names",
        ],
        requestDescriptors: match.arrayContaining([
          {
            example: {
              exportName: "ZodError",
              resolutionContext: "/absolute/path/to/consumer",
              specifier: "zod",
            },
            fields: [
              {
                format: "absolute-path",
                kind: "string",
                name: "resolutionContext",
                required: true,
              },
              { kind: "string", name: "specifier", required: true },
              {
                default: "import",
                kind: "enum",
                name: "accessStyle",
                required: false,
                values: ["import", "require"],
              },
              { kind: "string", name: "exportName", required: true },
            ],
            intent: "signature-inspection",
          },
          {
            example: {
              after: {
                resolutionContext: "/absolute/path/to/after-consumer",
                specifier: "zod",
              },
              before: {
                resolutionContext: "/absolute/path/to/before-consumer",
                specifier: "zod",
              },
            },
            fields: [
              {
                kind: "inspection-target",
                name: "before",
                required: true,
                resolutionContextFormat: "absolute-path",
              },
              {
                kind: "inspection-target",
                name: "after",
                required: true,
                resolutionContextFormat: "absolute-path",
              },
            ],
            intent: "public-interface-comparison",
          },
        ]),
        responseOptions: [
          {
            appliesTo: ["signature-inspection", "inspection-plan"],
            default: "structured",
            name: "signatureEvidence",
            values: ["structured", "exact", "both"],
          },
        ],
        supportedIntents: [
          "interface-overview",
          "export-inspection",
          "signature-inspection",
          "export-search",
          "public-subpath-discovery",
          "declaration-inspection",
          "member-inspection",
          "member-discovery",
          "inspection-plan",
          "public-interface-comparison",
        ],
        supportedProtocolVersions: [INSPECTION_PROTOCOL_VERSION],
      });
    });

    test("publishes one schema-valid capability catalog within its advertised bound", () => {
      const capabilities = inspectCapabilities();

      const reorderedCatalog = {
        ...capabilities,
        supportedIntents: capabilities.supportedIntents.toReversed(),
      };

      const reorderedRecoveryCatalog = {
        ...capabilities,
        recoveryReasons: capabilities.recoveryReasons.toReversed(),
      };

      expect([
        Result.isSuccess(
          Schema.decodeResult(inspectionCapabilitiesSchema)(capabilities)
        ),
        Buffer.byteLength(JSON.stringify(capabilities)) <=
          capabilities.limits.maxSerializedBytes,
        Result.isFailure(
          Schema.decodeUnknownResult(inspectionCapabilitiesSchema)(
            reorderedCatalog
          )
        ),
        Result.isFailure(
          Schema.decodeUnknownResult(inspectionCapabilitiesSchema)(
            reorderedRecoveryCatalog
          )
        ),
        Object.isFrozen(capabilities),
        Object.isFrozen(capabilities.requestDescriptors),
      ]).toStrictEqual([true, true, true, true, true, true]);
    });

    test("rejects contradictory request capability metadata at the schema seam", () => {
      expect(() =>
        withRequestFieldCapability(Schema.String, {
          kind: "string",
          maxBytes: 1,
          minBytes: 2,
        })
      ).toThrow(/./u);
      expect(() =>
        withRequestFieldCapability(Schema.String, {
          default: "unknown",
          kind: "enum",
          values: ["import", "require"],
        })
      ).toThrow(/./u);
      expect(() =>
        withRequestFieldCapability(Schema.Array(Schema.String), {
          kind: "member-path",
          maxItems: 1,
          minItems: 2,
        })
      ).toThrow(/./u);
    });

    test("keeps every published request example accepted by the Inspection Protocol", async () => {
      await Array.fromAsync(
        inspectCapabilities().requestDescriptors,
        async (descriptor) => {
          const response = await invokeInspectionProtocol({
            intent: descriptor.intent,
            protocolVersion: INSPECTION_PROTOCOL_VERSION,
            request: exampleInCurrentResolutionContext(
              descriptor.intent,
              descriptor.example
            ),
          });

          expect(
            "reason" in response.outcome ? response.outcome.reason : undefined
          ).not.toBe("invalid-request");
        }
      );
    });
  };
