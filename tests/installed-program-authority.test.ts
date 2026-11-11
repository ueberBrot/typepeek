import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  inspectExport,
  inspectExportDeclarations,
  inspectExportMembers,
  inspectInterfaceOverview,
  inspectPlan,
} from "#typepeek/inspection";
import { requireDefined } from "#typepeek/shared/defined-value";

import type { InstalledProgramAuthorityFixture } from "./helpers/installed-program-authority-fixture.ts";
import { materializeInstalledProgramAuthorityFixture } from "./helpers/installed-program-authority-fixture.ts";
import { match } from "./helpers/matchers.ts";

let fixture: InstalledProgramAuthorityFixture;

const inspect = async (exportName: string) =>
  await inspectExport({
    exportName,
    resolutionContext: fixture.standardSpacesContext,
    specifier: "@typepeek-fixture/standard-spaces",
  });

describe("Installed Evidence program authority", () => {
  beforeAll(async () => {
    fixture = await materializeInstalledProgramAuthorityFixture();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it.each([
    ["explicit-import", ["importOnly"]],
    ["explicit-require", ["requireOnly"]],
    ["implicit-import", ["importOnly"]],
    ["implicit-require", ["requireOnly"]],
    ["dual-modes", ["importOnly", "requireOnly"]],
  ] as const)(
    "preserves %s type-reference resolution conditions",
    async (subpath, names) => {
      const outcome = await inspectExportMembers({
        exportName: "Value",
        resolutionContext: fixture.conditionalTypeReferenceContext,
        specifier: `@typepeek-fixture/conditional-type-reference/${subpath}`,
      });

      expect(outcome).toMatchObject({
        result: {
          members: names.map((name) => ({ name, spaces: ["type"] })),
          totalMembers: names.length,
        },
        status: "success",
      });
    }
  );

  it("does not treat ordinary builtin-looking string literals as Node references", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: fixture.literalNodeContext,
      specifier: "@typepeek-fixture/node-literal",
    });

    expect(outcome).toMatchObject({ status: "success" });
  });

  it("does not validate an unrelated visible Node provider eagerly", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: fixture.brokenNodeContext,
      specifier: "@typepeek-fixture/node-literal",
    });

    expect(outcome).toMatchObject({ status: "success" });
  });

  it("ignores private Node references and recognizes standard library globals", async () => {
    const [privateReference, standardReference] = await Promise.all([
      inspectExport({
        exportName: "inspect",
        resolutionContext: fixture.brokenPrivateNodeContext,
        specifier: "@typepeek-fixture/broken-node-consumer",
      }),
      inspectExport({
        exportName: "inspect",
        resolutionContext: fixture.brokenStandardNodeContext,
        specifier: "@typepeek-fixture/broken-node-consumer",
      }),
    ]);

    expect([privateReference, standardReference]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("adds the visible Node provider for a public Node value global", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: fixture.globalNodeContext,
      specifier: "@typepeek-fixture/node-global",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExport: {
          signatures: [
            { kind: "call", text: "(value: typeof process): number" },
          ],
        },
      },
      status: "success",
    });
  });

  it("derives non-whitelisted value globals and qualified heritage from provider evidence", async () => {
    const collector = await inspectExport({
      exportName: "collector",
      resolutionContext: fixture.globalNodeContext,
      specifier: "@typepeek-fixture/node-global",
    });

    const stream = await inspectExport({
      exportName: "Stream",
      resolutionContext: fixture.globalNodeContext,
      specifier: "@typepeek-fixture/node-global",
    });

    expect([collector, stream]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("activates the provider from an isolated qualified heritage reference", async () => {
    const outcome = await inspectExport({
      exportName: "Stream",
      resolutionContext: fixture.heritageNodeContext,
      specifier: "@typepeek-fixture/node-heritage",
    });

    expect(outcome).toMatchObject({ status: "success" });
  });

  it("rejects an unresolved Node global without a visible provider", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: fixture.missingNodeContext,
      specifier: "@typepeek-fixture/missing-node-global",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  it("applies Node authority to visible parameter properties on private constructors", async () => {
    const [missingProvider, visibleProvider] = await Promise.all([
      inspectExport({
        exportName: "PrivateToken",
        resolutionContext: fixture.missingNodeContext,
        specifier: "@typepeek-fixture/missing-node-global",
      }),
      inspectExport({
        exportName: "PrivateToken",
        resolutionContext: fixture.sourceInferredNodeContext,
        specifier: "@typepeek-fixture/source-inferred-node",
      }),
    ]);

    expect([
      missingProvider,
      visibleProvider,
      JSON.stringify(visibleProvider).includes(
        "readonly processValue: typeof process;"
      ),
    ]).toStrictEqual([
      {
        message:
          "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
        reason: "unsupported-evidence",
        status: "unsupported",
      },
      match.objectContaining({ status: "success" }),
      true,
    ]);
  });

  it("rejects a provider that resolves only part of the public Node globals", async () => {
    const outcome = await inspectExport({
      exportName: "collector",
      resolutionContext: fixture.partialNodeContext,
      specifier: "@typepeek-fixture/partial-node-global",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  it("rejects a missing member from a directly referenced Node module", async () => {
    const outcome = await inspectExport({
      exportName: "Missing",
      resolutionContext: fixture.missingNodeMemberContext,
      specifier: "@typepeek-fixture/missing-node-member",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  it("rejects a missing directly referenced whole Node module", async () => {
    const outcome = await inspectExport({
      exportName: "Fs",
      resolutionContext: fixture.missingNodeModuleContext,
      specifier: "@typepeek-fixture/missing-node-module",
    });

    expect(outcome).toMatchObject({ status: "unsupported" });
  });

  it("retains standard library inference when adding Node declarations", async () => {
    const request = {
      exportName: "Values",
      resolutionContext: fixture.sourceInferredNodeContext,
      specifier: "@typepeek-fixture/source-inferred-node",
    };

    const outcome = await inspectExportDeclarations(request);
    expect([
      outcome,
      JSON.stringify(outcome).includes("first(): string | undefined;"),
    ]).toStrictEqual([match.objectContaining({ status: "success" }), true]);

    const plan = await inspectPlan({
      queries: [
        { exportName: request.exportName, intent: "declaration-inspection" },
        { exportName: request.exportName, intent: "signature-inspection" },
      ],
      resolutionContext: request.resolutionContext,
      specifier: request.specifier,
    });

    expect(plan).toMatchObject({ status: "success" });

    if (!(outcome.status === "success" && plan.status === "success")) {
      throw new Error("Expected a successful inspection result.");
    }

    expect(plan.result.inspections[0]).toStrictEqual(outcome.result);
  });

  it("loads Node authority for isolated source-inferred public types", async () => {
    const [value, getProcess, local, helper] = await Promise.all([
      inspectExport({
        exportName: "value",
        resolutionContext: fixture.sourceInferredNodeContext,
        specifier: "@typepeek-fixture/source-inferred-node",
      }),
      inspectExport({
        exportName: "getProcess",
        resolutionContext: fixture.sourceInferredReturnContext,
        specifier: "@typepeek-fixture/source-inferred-return",
      }),
      inspectExport({
        exportName: "local",
        resolutionContext: fixture.sourceInferredLocalContext,
        specifier: "@typepeek-fixture/source-inferred-local",
      }),
      inspectExport({
        exportName: "helper",
        resolutionContext: fixture.sourceInferredHelperContext,
        specifier: "@typepeek-fixture/source-inferred-helper",
      }),
    ]);

    expect([value, getProcess, local, helper]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("does not let an unrelated Node-only export poison a focused inspection", async () => {
    const focused = await inspectExport({
      exportName: "inspect",
      resolutionContext: fixture.focusedNodeContext,
      specifier: "@typepeek-fixture/focused-node",
    });

    const overview = await inspectInterfaceOverview({
      resolutionContext: fixture.focusedNodeContext,
      specifier: "@typepeek-fixture/focused-node",
    });

    expect([focused, overview]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "unsupported" }),
    ]);
  });

  it("preserves focused Node authority across multiple exports in a plan", async () => {
    const request = {
      resolutionContext: fixture.focusedNodeContext,
      specifier: "@typepeek-fixture/focused-node",
    };

    const names = ["inspect", "second"];

    const atomic = await Promise.all(
      names.map(
        async (exportName) => await inspectExport({ ...request, exportName })
      )
    );

    expect(atomic.map(({ status }) => status)).toStrictEqual([
      "success",
      "success",
    ]);

    await Array.fromAsync(
      [names, [...names].toReversed()],
      async (orderedNames) => {
        const plan = await inspectPlan({
          ...request,
          queries: orderedNames.map((exportName) => ({
            exportName,
            intent: "export-inspection",
          })),
        });

        expect(plan).toMatchObject({ status: "success" });

        if (plan.status !== "success") {
          throw new Error("Expected a successful inspection.");
        }

        expect(plan.result.inspections).toStrictEqual(
          orderedNames.map((name) => {
            const outcome = requireDefined(atomic[names.indexOf(name)]);

            return outcome.status === "success" ? outcome.result : undefined;
          })
        );
      }
    );
  });

  it.each([
    { exportName: "nodeOnly", intent: "export-inspection" },
    { intent: "interface-overview" },
  ] as const)(
    "retains Node authority for a plan's $intent query",
    async (query) => {
      const outcome = await inspectPlan({
        queries: [
          { exportName: "inspect", intent: "export-inspection" },
          query,
        ],
        resolutionContext: fixture.focusedNodeContext,
        specifier: "@typepeek-fixture/focused-node",
      });

      expect(outcome).toMatchObject({
        reason: "unsupported-evidence",
        status: "unsupported",
      });
      expect(outcome).not.toHaveProperty("result");
    }
  );

  it("follows typed and external dependencies of a source-inferred return", async () => {
    const [typed, wholeModule, external] = await Promise.all([
      inspectExport({
        exportName: "getFs",
        resolutionContext: fixture.sourceInferredTypedContext,
        specifier: "@typepeek-fixture/source-inferred-typed",
      }),
      inspectExport({
        exportName: "typedLocal",
        resolutionContext: fixture.sourceInferredTypedContext,
        specifier: "@typepeek-fixture/source-inferred-typed",
      }),
      inspectExport({
        exportName: "value",
        resolutionContext: fixture.sourceInferredExternalContext,
        specifier: "@typepeek-fixture/source-inferred-external",
      }),
    ]);

    expect([typed, wholeModule, external]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("validates public supporting types but ignores private members", async () => {
    const [publicMember, privateMember, protectedMember] = await Promise.all([
      inspectExport({
        exportName: "result",
        resolutionContext: fixture.supportingNodeContext,
        specifier: "@typepeek-fixture/supporting-node",
      }),
      inspectExport({
        exportName: "result",
        resolutionContext: fixture.privateSupportingNodeContext,
        specifier: "@typepeek-fixture/private-supporting-node",
      }),
      inspectExport({
        exportName: "result",
        resolutionContext: fixture.protectedSupportingNodeContext,
        specifier: "@typepeek-fixture/protected-supporting-node",
      }),
    ]);

    expect([publicMember, privateMember, protectedMember]).toStrictEqual([
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "unsupported" }),
    ]);
  });

  it("validates every public member of a focused namespace", async () => {
    const outcome = await inspectExport({
      exportName: "API",
      resolutionContext: fixture.namespaceNodeContext,
      specifier: "@typepeek-fixture/namespace-node",
    });

    expect(outcome).toMatchObject({ status: "unsupported" });
  });

  it("distinguishes standard-library type and value symbol spaces", async () => {
    const [
      invalidConsole,
      invalidIterable,
      invalidGlobalThis,
      invalidIntl,
      invalidConst,
      invalidIteratorObjectConstructor,
      validConsole,
      validIterable,
      validIntl,
    ] = await Promise.all([
      inspect("invalidConsole"),
      inspect("InvalidIterable"),
      inspect("InvalidGlobalThis"),
      inspect("InvalidIntl"),
      inspect("InvalidConst"),
      inspect("InvalidIteratorObjectConstructor"),
      inspect("validConsole"),
      inspect("validIterable"),
      inspect("ValidIntl"),
    ]);

    expect([
      invalidConsole,
      invalidIterable,
      invalidGlobalThis,
      invalidIntl,
      invalidConst,
      invalidIteratorObjectConstructor,
      validConsole,
      validIterable,
      validIntl,
    ]).toStrictEqual([
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({
        status: "unsupported",
      }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("validates inferred namespaces and retains their public supporting surface", async () => {
    const [publicNodeMember, privateNodeMember] = await Promise.all([
      inspectExport({
        exportName: "api",
        resolutionContext: fixture.inferredNamespaceContext,
        specifier: "@typepeek-fixture/inferred-namespace",
      }),
      inspectExport({
        exportName: "api",
        resolutionContext: fixture.privateInferredNamespaceContext,
        specifier: "@typepeek-fixture/private-inferred-namespace",
      }),
    ]);

    expect([publicNodeMember, privateNodeMember]).toStrictEqual([
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({
        result: match.objectContaining({
          supportingTypes: [match.objectContaining({ name: "API" })],
        }),
        status: "success",
      }),
    ]);
  });

  it("loads authority for inferred public members of a Supporting Type", async () => {
    const outcome = await inspectExport({
      exportName: "result",
      resolutionContext: fixture.inferredSupportingMemberContext,
      specifier: "@typepeek-fixture/inferred-supporting-member",
    });

    expect(outcome).toMatchObject({ status: "success" });
  });

  it("uses type-space authority for inferred generic type arguments", async () => {
    const [standard, validNode, missingNode] = await Promise.all([
      inspectExport({
        exportName: "value",
        resolutionContext: fixture.inferredGenericContext,
        specifier: "@typepeek-fixture/inferred-generic",
      }),
      inspectExport({
        exportName: "valid",
        resolutionContext: fixture.inferredNodeGenericContext,
        specifier: "@typepeek-fixture/inferred-node-generic",
      }),
      inspectExport({
        exportName: "missing",
        resolutionContext: fixture.inferredNodeGenericContext,
        specifier: "@typepeek-fixture/inferred-node-generic",
      }),
    ]);

    expect([standard, validNode, missingNode]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "unsupported" }),
    ]);
  });

  it("ignores overload implementations, constructors, setters, and decorators", async () => {
    const [overload, supportingType, decorator] = await Promise.all([
      inspectExport({
        exportName: "inspect",
        resolutionContext: fixture.overloadImplementationContext,
        specifier: "@typepeek-fixture/overload-implementation",
      }),
      inspectExport({
        exportName: "result",
        resolutionContext: fixture.privateSupportingNodeContext,
        specifier: "@typepeek-fixture/private-supporting-node",
      }),
      inspectExport({
        exportName: "Result",
        resolutionContext: fixture.decoratorContext,
        specifier: "@typepeek-fixture/decorator",
      }),
    ]);

    expect([overload, supportingType, decorator]).toStrictEqual([
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("validates rendered computed names and permits standard Symbol members", async () => {
    const [bad, badFor, badKeyFor, good, dispose, custom] = await Promise.all([
      inspectExport({
        exportName: "BadFor",
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
      }),
      inspectExport({
        exportName: "BadKeyFor",
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
      }),
      inspectExport({
        exportName: "Bad",
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
      }),
      inspectExport({
        exportName: "Good",
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
      }),
      inspectExport({
        exportName: "Dispose",
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
      }),
      inspectExport({
        exportName: "Custom",
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
      }),
    ]);

    expect([bad, badFor, badKeyFor, good, dispose, custom]).toStrictEqual([
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
      match.objectContaining({ status: "success" }),
    ]);
  });

  it("rejects an unresolved qualified name with a standard-library root", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: fixture.invalidStandardContext,
      specifier: "@typepeek-fixture/invalid-standard",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  it("does not treat a package-local Node-shaped type as provider evidence", async () => {
    const outcome = await inspectExport({
      exportName: "inspect",
      resolutionContext: fixture.localNodeContext,
      specifier: "@typepeek-fixture/local-node-global",
    });

    expect(outcome).toMatchObject({
      result: {
        moduleExport: {
          signatures: [{ kind: "call", text: "(value: Buffer): number" }],
        },
      },
      status: "success",
    });
  });

  it("does not authorize a visible Node provider through a relative symlink", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: fixture.symlinkNodeContext,
      specifier: "@typepeek-fixture/node-symlink",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration references source outside its installed package boundary.",
      reason: "static-boundary",
      status: "static-boundary",
    });
  });

  it("authorizes a declared runtime dependency's automatic declaration provider", async () => {
    const overview = await inspectInterfaceOverview({
      resolutionContext: fixture.automaticProviderContext,
      specifier: "@typepeek-fixture/automatic-provider",
    });

    const focused = await inspectExport({
      exportName: "helper",
      resolutionContext: fixture.automaticProviderContext,
      specifier: "@typepeek-fixture/automatic-provider",
    });

    expect([overview, focused]).toStrictEqual([
      match.objectContaining({
        result: match.objectContaining({
          moduleExports: [match.objectContaining({ name: "helper" })],
        }),
        status: "success",
      }),
      match.objectContaining({
        result: match.objectContaining({
          moduleExport: match.objectContaining({
            signatures: [
              match.objectContaining({
                kind: "call",
                text: "(value: string): number",
              }),
            ],
          }),
        }),
        status: "success",
      }),
    ]);
  });

  it("rejects an automatic declaration provider with the wrong Package Identity", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: fixture.automaticWrongProviderContext,
      specifier: "@typepeek-fixture/automatic-provider",
    });

    expect(outcome).toStrictEqual({
      message:
        "A declaration re-export could not be resolved from Installed Evidence.",
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });
});
