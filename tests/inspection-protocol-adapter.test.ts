import { Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  inspectCapabilities,
  invokeInspectionProtocol,
} from "#typepeek/inspection";
import { inspectionProtocolResponseSchema } from "#typepeek/inspection/model/inspection-protocol-schema";

import type { CompiledPackageFixture } from "./helpers/compiled-package-fixture.ts";
import { materializeCompiledPackageFixture } from "./helpers/compiled-package-fixture.ts";
import { match } from "./helpers/matchers.ts";
import { registerCapabilityCatalogTests } from "./inspection-protocol-adapter/capability-catalog.test.suite.ts";
import { registerDocumentationSearchTests } from "./inspection-protocol-adapter/documentation-search.test.suite.ts";
import { registerRecoveryGuidanceTests } from "./inspection-protocol-adapter/recovery-guidance.test.suite.ts";
import { registerRequestAdmissionTests } from "./inspection-protocol-adapter/request-admission.test.suite.ts";
import { registerResponseContractTests } from "./inspection-protocol-adapter/response-contract.test.suite.ts";

let fixture: CompiledPackageFixture;

describe("inspection-protocol-adapter", () => {
  beforeAll(async () => {
    fixture = await materializeCompiledPackageFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  registerDocumentationSearchTests(() => fixture);
  registerCapabilityCatalogTests();
  registerResponseContractTests(() => fixture);
  registerRecoveryGuidanceTests(() => fixture);
  registerRequestAdmissionTests(() => fixture);

  it("publishes qualified Member selector grammar and optional discovery fields", () => {
    const descriptor = inspectCapabilities().requestDescriptors.find(
      (entry) => entry.intent === "member-discovery"
    );

    expect([descriptor, inspectCapabilities().budgetDimensions]).toStrictEqual([
      match.objectContaining({
        fields: match.arrayContaining([
          {
            kind: "member-path",
            maxItemBytes: 256,
            maxItems: 16,
            minItems: 0,
            name: "memberPath",
            qualified: {
              name: "name",
              space: "space",
              values: ["type", "value", "namespace"],
            },
            required: false,
            unqualified: true,
          },
          {
            kind: "string",
            maxBytes: 256,
            minBytes: 1,
            name: "query",
            required: false,
          },
        ]),
      }),
      match.arrayContaining(["member-candidates", "member-matches"]),
    ]);
  });

  it("discovers filtered Members and executes qualified follow-up inspection through the protocol", async () => {
    const target = {
      exportName: "PublicShape",
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
    };

    const discovery = await invokeInspectionProtocol({
      intent: "member-discovery",
      protocolVersion: "1",
      request: { ...target, query: "VIS" },
    });

    expect([
      discovery,
      Result.isSuccess(
        Schema.decodeResult(inspectionProtocolResponseSchema)(discovery)
      ),
    ]).toStrictEqual([
      match.objectContaining({
        outcome: match.objectContaining({
          result: match.objectContaining({
            intent: "member-discovery",
            memberPath: [],
            members: [
              match.objectContaining({ name: "visible", spaces: ["type"] }),
            ],
            query: "VIS",
            totalMembers: 2,
          }),
          status: "success",
        }),
      }),
      true,
    ]);

    const followup = await invokeInspectionProtocol({
      intent: "inspection-plan",
      protocolVersion: "1",
      request: {
        ...target,
        queries: [
          {
            exportName: "PublicShape",
            intent: "member-discovery",
            query: "absent",
          },
          {
            exportName: "PublicShape",
            intent: "member-inspection",
            memberPath: [{ name: "visible", space: "type" }],
          },
        ],
      },
    });

    expect([
      followup,
      Result.isSuccess(
        Schema.decodeResult(inspectionProtocolResponseSchema)(followup)
      ),
    ]).toStrictEqual([
      match.objectContaining({
        outcome: match.objectContaining({
          result: match.objectContaining({
            inspections: [
              match.objectContaining({
                intent: "member-discovery",
                members: [],
                totalMembers: 2,
              }),
              match.objectContaining({
                intent: "member-inspection",
                memberPath: [
                  match.objectContaining({ name: "visible", space: "type" }),
                ],
              }),
            ],
            intent: "inspection-plan",
          }),
          status: "success",
        }),
      }),
      true,
    ]);
  });
});
