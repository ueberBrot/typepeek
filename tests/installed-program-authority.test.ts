import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";

import {
  type InstalledProgramAuthorityFixture,
  materializeInstalledProgramAuthorityFixture,
} from "./helpers/index.ts";

describe("Installed Evidence program authority", () => {
  let fixture: InstalledProgramAuthorityFixture;

  beforeAll(async () => {
    fixture = await materializeInstalledProgramAuthorityFixture();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

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
        resolutionContext: fixture.brokenPrivateNodeContext,
        specifier: "@typepeek-fixture/broken-node-consumer",
        exportName: "inspect",
      }),
      inspectExport({
        resolutionContext: fixture.brokenStandardNodeContext,
        specifier: "@typepeek-fixture/broken-node-consumer",
        exportName: "inspect",
      }),
    ]);

    expect(privateReference).toMatchObject({ status: "success" });
    expect(standardReference).toMatchObject({ status: "success" });
  });

  it("adds the visible Node provider for a public Node value global", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.globalNodeContext,
      specifier: "@typepeek-fixture/node-global",
      exportName: "inspect",
    });

    expect(outcome).toMatchObject({
      status: "success",
      result: {
        moduleExport: {
          signatures: [{ kind: "call", text: "(value: typeof process): number" }],
        },
      },
    });
  });

  it("derives non-whitelisted value globals and qualified heritage from provider evidence", async () => {
    const collector = await inspectExport({
      resolutionContext: fixture.globalNodeContext,
      specifier: "@typepeek-fixture/node-global",
      exportName: "collector",
    });
    const stream = await inspectExport({
      resolutionContext: fixture.globalNodeContext,
      specifier: "@typepeek-fixture/node-global",
      exportName: "Stream",
    });

    expect(collector).toMatchObject({ status: "success" });
    expect(stream).toMatchObject({ status: "success" });
  });

  it("activates the provider from an isolated qualified heritage reference", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.heritageNodeContext,
      specifier: "@typepeek-fixture/node-heritage",
      exportName: "Stream",
    });

    expect(outcome).toMatchObject({ status: "success" });
  });

  it("rejects an unresolved Node global without a visible provider", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.missingNodeContext,
      specifier: "@typepeek-fixture/missing-node-global",
      exportName: "inspect",
    });

    expect(outcome).toEqual({
      status: "unsupported",
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
    });
  });

  it("applies Node authority to visible parameter properties on private constructors", async () => {
    const [missingProvider, visibleProvider] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.missingNodeContext,
        specifier: "@typepeek-fixture/missing-node-global",
        exportName: "PrivateToken",
      }),
      inspectExport({
        resolutionContext: fixture.sourceInferredNodeContext,
        specifier: "@typepeek-fixture/source-inferred-node",
        exportName: "PrivateToken",
      }),
    ]);

    expect(missingProvider).toEqual({
      status: "unsupported",
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
    });
    expect(visibleProvider).toMatchObject({ status: "success" });
    expect(JSON.stringify(visibleProvider)).toContain("readonly processValue: typeof process;");
  });

  it("rejects a provider that resolves only part of the public Node globals", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.partialNodeContext,
      specifier: "@typepeek-fixture/partial-node-global",
      exportName: "collector",
    });

    expect(outcome).toEqual({
      status: "unsupported",
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
    });
  });

  it("rejects a missing member from a directly referenced Node module", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.missingNodeMemberContext,
      specifier: "@typepeek-fixture/missing-node-member",
      exportName: "Missing",
    });

    expect(outcome).toEqual({
      status: "unsupported",
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
    });
  });

  it("rejects a missing directly referenced whole Node module", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.missingNodeModuleContext,
      specifier: "@typepeek-fixture/missing-node-module",
      exportName: "Fs",
    });

    expect(outcome).toMatchObject({ status: "unsupported" });
  });

  it("loads Node authority for isolated source-inferred public types", async () => {
    const [value, getProcess, local, helper] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.sourceInferredNodeContext,
        specifier: "@typepeek-fixture/source-inferred-node",
        exportName: "value",
      }),
      inspectExport({
        resolutionContext: fixture.sourceInferredReturnContext,
        specifier: "@typepeek-fixture/source-inferred-return",
        exportName: "getProcess",
      }),
      inspectExport({
        resolutionContext: fixture.sourceInferredLocalContext,
        specifier: "@typepeek-fixture/source-inferred-local",
        exportName: "local",
      }),
      inspectExport({
        resolutionContext: fixture.sourceInferredHelperContext,
        specifier: "@typepeek-fixture/source-inferred-helper",
        exportName: "helper",
      }),
    ]);

    expect(value).toMatchObject({ status: "success" });
    expect(getProcess).toMatchObject({ status: "success" });
    expect(local).toMatchObject({ status: "success" });
    expect(helper).toMatchObject({ status: "success" });
  });

  it("does not let an unrelated Node-only export poison a focused inspection", async () => {
    const focused = await inspectExport({
      resolutionContext: fixture.focusedNodeContext,
      specifier: "@typepeek-fixture/focused-node",
      exportName: "inspect",
    });
    const overview = await inspectInterfaceOverview({
      resolutionContext: fixture.focusedNodeContext,
      specifier: "@typepeek-fixture/focused-node",
    });

    expect(focused).toMatchObject({ status: "success" });
    expect(overview).toMatchObject({ status: "unsupported" });
  });

  it("follows typed and external dependencies of a source-inferred return", async () => {
    const [typed, wholeModule, external] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.sourceInferredTypedContext,
        specifier: "@typepeek-fixture/source-inferred-typed",
        exportName: "getFs",
      }),
      inspectExport({
        resolutionContext: fixture.sourceInferredTypedContext,
        specifier: "@typepeek-fixture/source-inferred-typed",
        exportName: "typedLocal",
      }),
      inspectExport({
        resolutionContext: fixture.sourceInferredExternalContext,
        specifier: "@typepeek-fixture/source-inferred-external",
        exportName: "value",
      }),
    ]);

    expect(typed).toMatchObject({ status: "success" });
    expect(wholeModule).toMatchObject({ status: "success" });
    expect(external).toMatchObject({ status: "success" });
  });

  it("validates public supporting types but ignores private members", async () => {
    const [publicMember, privateMember, protectedMember] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.supportingNodeContext,
        specifier: "@typepeek-fixture/supporting-node",
        exportName: "result",
      }),
      inspectExport({
        resolutionContext: fixture.privateSupportingNodeContext,
        specifier: "@typepeek-fixture/private-supporting-node",
        exportName: "result",
      }),
      inspectExport({
        resolutionContext: fixture.protectedSupportingNodeContext,
        specifier: "@typepeek-fixture/protected-supporting-node",
        exportName: "result",
      }),
    ]);

    expect(publicMember).toMatchObject({ status: "unsupported" });
    expect(privateMember).toMatchObject({ status: "success" });
    expect(protectedMember).toMatchObject({ status: "unsupported" });
  });

  it("validates every public member of a focused namespace", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.namespaceNodeContext,
      specifier: "@typepeek-fixture/namespace-node",
      exportName: "API",
    });

    expect(outcome).toMatchObject({ status: "unsupported" });
  });

  it("distinguishes standard-library type and value symbol spaces", async () => {
    const inspect = (exportName: string) =>
      inspectExport({
        resolutionContext: fixture.standardSpacesContext,
        specifier: "@typepeek-fixture/standard-spaces",
        exportName,
      });
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

    expect(invalidConsole).toMatchObject({ status: "unsupported" });
    expect(invalidIterable).toMatchObject({ status: "unsupported" });
    expect(invalidGlobalThis).toMatchObject({ status: "unsupported" });
    expect(invalidIntl).toMatchObject({ status: "unsupported" });
    expect(invalidConst).toMatchObject({ status: "unsupported" });
    expect(invalidIteratorObjectConstructor).toMatchObject({ status: "unsupported" });
    expect(validConsole).toMatchObject({ status: "success" });
    expect(validIterable).toMatchObject({ status: "success" });
    expect(validIntl).toMatchObject({ status: "success" });
  });

  it("validates inferred namespaces and retains their public supporting surface", async () => {
    const [publicNodeMember, privateNodeMember] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.inferredNamespaceContext,
        specifier: "@typepeek-fixture/inferred-namespace",
        exportName: "api",
      }),
      inspectExport({
        resolutionContext: fixture.privateInferredNamespaceContext,
        specifier: "@typepeek-fixture/private-inferred-namespace",
        exportName: "api",
      }),
    ]);

    expect(publicNodeMember).toMatchObject({ status: "unsupported" });
    expect(privateNodeMember).toMatchObject({
      status: "success",
      result: { supportingTypes: [{ name: "API" }] },
    });
  });

  it("loads authority for inferred public members of a Supporting Type", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.inferredSupportingMemberContext,
      specifier: "@typepeek-fixture/inferred-supporting-member",
      exportName: "result",
    });

    expect(outcome).toMatchObject({ status: "success" });
  });

  it("uses type-space authority for inferred generic type arguments", async () => {
    const [standard, validNode, missingNode] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.inferredGenericContext,
        specifier: "@typepeek-fixture/inferred-generic",
        exportName: "value",
      }),
      inspectExport({
        resolutionContext: fixture.inferredNodeGenericContext,
        specifier: "@typepeek-fixture/inferred-node-generic",
        exportName: "valid",
      }),
      inspectExport({
        resolutionContext: fixture.inferredNodeGenericContext,
        specifier: "@typepeek-fixture/inferred-node-generic",
        exportName: "missing",
      }),
    ]);

    expect(standard).toMatchObject({ status: "success" });
    expect(validNode).toMatchObject({ status: "success" });
    expect(missingNode).toMatchObject({ status: "unsupported" });
  });

  it("ignores overload implementations, constructors, setters, and decorators", async () => {
    const [overload, supportingType, decorator] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.overloadImplementationContext,
        specifier: "@typepeek-fixture/overload-implementation",
        exportName: "inspect",
      }),
      inspectExport({
        resolutionContext: fixture.privateSupportingNodeContext,
        specifier: "@typepeek-fixture/private-supporting-node",
        exportName: "result",
      }),
      inspectExport({
        resolutionContext: fixture.decoratorContext,
        specifier: "@typepeek-fixture/decorator",
        exportName: "Result",
      }),
    ]);

    expect(overload).toMatchObject({ status: "success" });
    expect(supportingType).toMatchObject({ status: "success" });
    expect(decorator).toMatchObject({ status: "success" });
  });

  it("validates rendered computed names and permits standard Symbol members", async () => {
    const [bad, badFor, badKeyFor, good, dispose, custom] = await Promise.all([
      inspectExport({
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
        exportName: "BadFor",
      }),
      inspectExport({
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
        exportName: "BadKeyFor",
      }),
      inspectExport({
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
        exportName: "Bad",
      }),
      inspectExport({
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
        exportName: "Good",
      }),
      inspectExport({
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
        exportName: "Dispose",
      }),
      inspectExport({
        resolutionContext: fixture.computedNameContext,
        specifier: "@typepeek-fixture/computed-name",
        exportName: "Custom",
      }),
    ]);

    expect(bad).toMatchObject({ status: "unsupported" });
    expect(badFor).toMatchObject({ status: "unsupported" });
    expect(badKeyFor).toMatchObject({ status: "unsupported" });
    expect(good).toMatchObject({ status: "success" });
    expect(dispose).toMatchObject({ status: "success" });
    expect(custom).toMatchObject({ status: "success" });
  });

  it("rejects an unresolved qualified name with a standard-library root", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.invalidStandardContext,
      specifier: "@typepeek-fixture/invalid-standard",
      exportName: "inspect",
    });

    expect(outcome).toEqual({
      status: "unsupported",
      message:
        "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
    });
  });

  it("does not treat a package-local Node-shaped type as provider evidence", async () => {
    const outcome = await inspectExport({
      resolutionContext: fixture.localNodeContext,
      specifier: "@typepeek-fixture/local-node-global",
      exportName: "inspect",
    });

    expect(outcome).toMatchObject({
      status: "success",
      result: {
        moduleExport: {
          signatures: [{ kind: "call", text: "(value: Buffer): number" }],
        },
      },
    });
  });

  it("does not authorize a visible Node provider through a relative symlink", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: fixture.symlinkNodeContext,
      specifier: "@typepeek-fixture/node-symlink",
    });

    expect(outcome).toEqual({
      status: "static-boundary",
      message: "A declaration references source outside its installed package boundary.",
    });
  });

  it("authorizes a declared runtime dependency's automatic declaration provider", async () => {
    const overview = await inspectInterfaceOverview({
      resolutionContext: fixture.automaticProviderContext,
      specifier: "@typepeek-fixture/automatic-provider",
    });
    const focused = await inspectExport({
      resolutionContext: fixture.automaticProviderContext,
      specifier: "@typepeek-fixture/automatic-provider",
      exportName: "helper",
    });

    expect(overview).toMatchObject({
      status: "success",
      result: { moduleExports: [{ name: "helper" }] },
    });
    expect(focused).toMatchObject({
      status: "success",
      result: {
        moduleExport: {
          signatures: [{ kind: "call", text: "(value: string): number" }],
        },
      },
    });
  });

  it("rejects an automatic declaration provider with the wrong Package Identity", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: fixture.automaticWrongProviderContext,
      specifier: "@typepeek-fixture/automatic-provider",
    });

    expect(outcome).toEqual({
      status: "unsupported",
      message: "A declaration re-export could not be resolved from Installed Evidence.",
    });
  });
});
