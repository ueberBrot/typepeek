import { live as liveIt, effect as scopedIt } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { comparePublicInterfaces } from "#typepeek/inspection";
import { invokeInspectionCore } from "#typepeek/inspection/core";

import type { CompiledPackageFixture } from "./helpers/compiled-package-fixture.ts";
import { materializeCompiledPackageFixture } from "./helpers/compiled-package-fixture.ts";
import { match } from "./helpers/matchers.ts";
import { registerBudgetTests } from "./inspection-core/budgets.test.suite.ts";
import { registerDeclarationSpaceTests } from "./inspection-core/declaration-spaces.test.suite.ts";
import { registerEvidenceAuthorityTests } from "./inspection-core/evidence-authority.test.suite.ts";
import { registerExportAliasTests } from "./inspection-core/export-aliases.test.suite.ts";
import { registerFocusedQueryTests } from "./inspection-core/focused-queries.test.suite.ts";
import { registerInvocationTests } from "./inspection-core/invocation.test.suite.ts";
import { registerPublicDeclarationTests } from "./inspection-core/public-declarations.test.suite.ts";
import { registerResolutionTests } from "./inspection-core/resolution.test.suite.ts";
import { registerSignatureTests } from "./inspection-core/signatures.test.suite.ts";
import { registerSupportingTypeTests } from "./inspection-core/supporting-types.test.suite.ts";

let fixture: CompiledPackageFixture;

const verifyEffectScenario = function* verifyEffectScenario() {
  let descriptorReads = 0;

  const request = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(target, property) {
        descriptorReads += 1;

        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }
  );

  const invocation = invokeInspectionCore("interface-overview", request);
  expect(descriptorReads).toBe(0);
  const receipt = yield* invocation;
  expect([descriptorReads > 0, receipt]).toStrictEqual([
    true,
    {
      outcome: {
        message: "Inspection received an invalid Interface Overview request.",
        reason: "invalid-request",
        status: "unsupported",
      },
    },
  ]);
};

const verifyEffectScenario2 = function* verifyEffectScenario2() {
  const analysisRequest = {
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/focused",
  };

  const analysisReceipt = yield* invokeInspectionCore(
    "interface-overview",
    analysisRequest
  );

  if (analysisReceipt.preparedRequest === undefined) {
    throw new Error("Expected an accepted analysis request");
  }

  expect([
    analysisReceipt.preparedRequest,
    analysisReceipt.outcome,
  ]).toStrictEqual([
    {
      intent: "interface-overview",
      request: { ...analysisRequest, accessStyle: "import" },
    },
    match.objectContaining({
      result: match.objectContaining({
        intent: "interface-overview",
        resolutionVariant: match.objectContaining({
          accessStyle: "import",
        }),
        specifier: analysisRequest.specifier,
      }),
      status: "success",
    }),
  ]);

  const comparisonRequest = {
    after: {
      accessStyle: "require" as const,
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/conditional",
    },
    before: {
      accessStyle: "import" as const,
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/conditional",
    },
  };

  const comparisonReceipt = yield* invokeInspectionCore(
    "public-interface-comparison",
    comparisonRequest
  );

  if (comparisonReceipt.preparedRequest === undefined) {
    throw new Error("Expected an accepted comparison request");
  }

  expect([
    comparisonReceipt.preparedRequest,
    comparisonReceipt.outcome,
  ]).toStrictEqual([
    {
      intent: "public-interface-comparison",
      request: comparisonRequest,
    },
    match.objectContaining({
      result: match.objectContaining({
        after: match.objectContaining({
          resolutionVariant: match.objectContaining({
            accessStyle: "require",
          }),
        }),
        before: match.objectContaining({
          resolutionVariant: match.objectContaining({
            accessStyle: "import",
          }),
        }),
        intent: "public-interface-comparison",
        moduleExports: match.objectContaining({
          added: [match.objectContaining({ name: "requireExport" })],
          removed: [match.objectContaining({ name: "importExport" })],
        }),
      }),
      status: "success",
    }),
  ]);
};

describe("inspection-core", () => {
  beforeAll(async () => {
    fixture = await materializeCompiledPackageFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  scopedIt(
    "defers request reading and returns a rejected invocation receipt",
    () => Effect.gen(verifyEffectScenario)
  );

  liveIt(
    "dispatches normalized analysis and comparison requests through the canonical Effect",
    () => Effect.gen(verifyEffectScenario2),
    120_000
  );

  it("compares complete Interface Overview indexes without merging Resolution Variants", async () => {
    const outcome = await comparePublicInterfaces({
      after: {
        accessStyle: "require",
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/conditional",
      },
      before: {
        accessStyle: "import",
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/conditional",
      },
    });

    expect(outcome).toMatchObject({
      result: {
        after: {
          resolutionVariant: { accessStyle: "require" },
          specifier: "@typepeek-fixture/conditional",
        },
        before: {
          resolutionVariant: { accessStyle: "import" },
          specifier: "@typepeek-fixture/conditional",
        },
        intent: "public-interface-comparison",
        moduleExports: {
          added: [{ name: "requireExport" }],
          removed: [{ name: "importExport" }],
        },
        publicSubpaths: {
          added: [
            { specifier: "@typepeek-fixture/conditional/require-feature" },
            {
              specifier: "@typepeek-fixture/conditional/require-patterns/blue",
            },
          ],
          removed: [],
        },
        scope: "interface-overview",
      },
      status: "success",
    });
  });

  registerInvocationTests(() => fixture);
  registerFocusedQueryTests(() => fixture);
  registerResolutionTests(() => fixture);
  registerDeclarationSpaceTests(() => fixture);
  registerSignatureTests(() => fixture);
  registerPublicDeclarationTests(() => fixture);
  registerSupportingTypeTests(() => fixture);
  registerExportAliasTests(() => fixture);
  registerBudgetTests(() => fixture);
  registerEvidenceAuthorityTests(() => fixture);
});
