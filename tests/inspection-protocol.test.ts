import { expect, expectTypeOf, it } from "vite-plus/test";

import {
  enforceInspectionOutcome,
  type ExportDeclarationSpace,
  type ExportInspection,
  type ExportNamespaceMember,
  type InterfaceOverview,
  type ModuleExportIndexEntry,
  type PackageIdentity,
  type PublicSubpath,
} from "#typepeek/inspection/protocol";
import { readAnalysisRequest, readInspectionRequest } from "#typepeek/inspection/request-codec";

it("normalizes the default Access Style at the process-entry protocol seam", () => {
  expect(
    readInspectionRequest("interface-overview", {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: undefined,
      ignoredTransportField: true,
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "import",
    },
  });
});

it("rejects an invalid Access Style at the process-entry protocol seam", () => {
  expect(
    readInspectionRequest("interface-overview", {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "script",
    }),
  ).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid Interface Overview request.",
    },
  });
});

it("rejects array-shaped records at the process-entry protocol seam", () => {
  const request = Object.assign([], {
    resolutionContext: "/repository",
    specifier: "example",
  });
  expect(readInspectionRequest("interface-overview", request)).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid Interface Overview request.",
    },
  });

  const envelope = Object.assign([], {
    intent: "interface-overview",
    request: {
      resolutionContext: "/repository",
      specifier: "example",
    },
  });
  expect(readAnalysisRequest(envelope)).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid request.",
    },
  });
});

it("rejects a structurally incomplete successful Inspection Outcome", () => {
  expect(
    enforceInspectionOutcome("interface-overview", {
      status: "success",
      result: {},
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects a structurally valid success for a different inspection intent", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "interface-overview",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example" },
      publicSubpaths: [],
      moduleExports: [{ name: "createExample" }],
    },
  };

  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("accepts a provider-backed Platform Module without a Package Identity", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "interface-overview",
      specifier: "node:fs",
      resolutionVariant: { accessStyle: "import" },
      declarationProvider: { name: "@types/node", version: "24.13.3" },
      publicSubpaths: [],
      moduleExports: [{ name: "readFile" }],
    },
  } as const;

  expect(enforceInspectionOutcome("interface-overview", outcome)).toEqual(outcome);
});

it("rejects a successful result without an evidence identity", () => {
  expect(
    enforceInspectionOutcome("interface-overview", {
      status: "success",
      result: {
        intent: "interface-overview",
        specifier: "identity-free",
        publicSubpaths: [],
        moduleExports: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it.each(["not-found", "unsupported", "static-boundary", "limit-exceeded"] as const)(
  "preserves an intent-neutral %s Inspection Failure",
  (status) => {
    const outcome = {
      status,
      message: `${status} outcome`,
    } as const;

    expect(enforceInspectionOutcome("interface-overview", outcome)).toEqual(outcome);
    expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual(outcome);
    expect(enforceInspectionOutcome("signature-inspection", outcome)).toEqual(outcome);
  },
);

it("normalizes an Export Inspection request at the process-entry protocol seam", () => {
  expect(
    readInspectionRequest("export-inspection", {
      resolutionContext: "/repository",
      specifier: "example",
      exportName: "createExample",
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      exportName: "createExample",
      accessStyle: "import",
    },
  });
});

it("discriminates the Export Inspection analysis intent", () => {
  expect(
    readAnalysisRequest({
      intent: "export-inspection",
      request: {
        resolutionContext: "/repository",
        specifier: "example",
        exportName: "createExample",
        accessStyle: "require",
      },
    }),
  ).toEqual({
    accepted: true,
    request: {
      intent: "export-inspection",
      request: {
        resolutionContext: "/repository",
        specifier: "example",
        exportName: "createExample",
        accessStyle: "require",
      },
    },
  });
});

it("normalizes and discriminates a Signature Inspection request", () => {
  const request = {
    resolutionContext: "/repository",
    specifier: "example",
    exportName: "createExample",
  };

  expect(readInspectionRequest("signature-inspection", request)).toEqual({
    accepted: true,
    request: { ...request, accessStyle: "import" },
  });
  expect(
    readAnalysisRequest({
      intent: "signature-inspection",
      request: { ...request, accessStyle: "require" },
    }),
  ).toEqual({
    accepted: true,
    request: {
      intent: "signature-inspection",
      request: { ...request, accessStyle: "require" },
    },
  });
});

it("accepts only the bounded Signature Inspection result shape", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "signature-inspection",
      specifier: "example",
      resolutionVariant: { accessStyle: "require" },
      packageIdentity: { name: "example", version: "1.0.0" },
      moduleExport: {
        name: "createExample",
        aliasTargetName: "buildExample",
        signatures: [
          {
            kind: "call",
            text: "(input: string): number",
            typeParameters: [],
            parameters: [
              {
                binding: { kind: "identifier", name: "input", synthetic: false },
                type: "string",
                optional: false,
                rest: false,
              },
            ],
            returns: { kind: "type", type: "number" },
          },
        ],
      },
    },
  } as const;

  expect(enforceInspectionOutcome("signature-inspection", outcome)).toEqual(outcome);
  expect(
    enforceInspectionOutcome("signature-inspection", {
      ...outcome,
      result: {
        ...outcome.result,
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
  expect(
    enforceInspectionOutcome("signature-inspection", {
      ...outcome,
      result: {
        ...outcome.result,
        moduleExport: {
          ...outcome.result.moduleExport,
          signatures: outcome.result.moduleExport.signatures.map(
            ({ returns: _, ...signature }) => signature,
          ),
        },
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("bounds protocol graph validation before structural schema checking", () => {
  expect(
    enforceInspectionOutcome("interface-overview", {
      status: "success",
      result: {
        intent: "interface-overview",
        specifier: "example",
        packageIdentity: { name: "example" },
        publicSubpaths: [],
        moduleExports: Array.from({ length: 4_097 }, (_, index) => ({ name: `item${index}` })),
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects compiler-shaped data in a focused Inspection Outcome", () => {
  const spaces = Object.assign(
    [
      {
        space: "value",
        declarations: [
          {
            kind: "function",
            text: "function createExample(): void;",
            provenance: {
              packageIdentity: { name: "example" },
              file: "index.d.ts",
              line: 1,
              column: 1,
            },
          },
        ],
      },
    ],
    { compilerNode: { flags: 1 } },
  );
  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "createExample",
          spaces,
          signatures: [],
        },
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects arrays with shadowed traversal methods without calling them", () => {
  const members = [namespaceMember("nested")];
  Object.defineProperty(members, "every", {
    value: null,
    enumerable: true,
  });
  expect(enforceInspectionOutcome("export-inspection", namespaceOutcome(members))).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });

  const outcome = namespaceOutcome([namespaceMember("nested")]);
  Object.defineProperty(outcome.result.moduleExport.spaces, "every", {
    value: null,
    enumerable: true,
  });
  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects accessor properties without evaluating them", () => {
  const outcome = {
    status: "not-found",
    message: "missing",
  };
  Object.defineProperty(outcome, "extra", {
    enumerable: true,
    get() {
      throw new Error("getter was evaluated");
    },
  });

  expect(enforceInspectionOutcome("interface-overview", outcome)).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("contains throwing accessors on non-record parser inputs", () => {
  const request: unknown[] = [];
  Object.defineProperty(request, "resolutionContext", {
    get() {
      throw new Error("request getter was evaluated");
    },
  });
  expect(readInspectionRequest("interface-overview", request)).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid Interface Overview request.",
    },
  });

  const envelope: unknown[] = [];
  Object.defineProperty(envelope, "intent", {
    get() {
      throw new Error("envelope getter was evaluated");
    },
  });
  expect(readAnalysisRequest(envelope)).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid request.",
    },
  });

  const outcome: unknown[] = [];
  Object.defineProperties(outcome, {
    status: { value: "not-found" },
    message: {
      get() {
        throw new Error("outcome getter was evaluated");
      },
    },
  });
  expect(enforceInspectionOutcome("interface-overview", outcome)).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects request fields that change after schema validation", () => {
  let specifierReads = 0;
  const request = {
    resolutionContext: "/repository",
    get specifier() {
      specifierReads += 1;
      return specifierReads === 1 ? "example" : 42;
    },
  };

  expect(readInspectionRequest("interface-overview", request)).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid Interface Overview request.",
    },
  });
});

it("rejects arrays and functions masquerading as Inspection Outcome records", () => {
  const arrayOutcome: unknown[] = [];
  Object.setPrototypeOf(arrayOutcome, {
    status: "not-found",
    message: "missing",
  });
  expect(enforceInspectionOutcome("interface-overview", arrayOutcome)).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });

  const functionOutcome = Object.assign(() => undefined, {
    status: "not-found",
    message: "missing",
  });
  expect(enforceInspectionOutcome("interface-overview", functionOutcome)).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("does not let a function-shaped result bypass recursive namespace bounds", () => {
  const cyclic = namespaceMember("cyclic");
  cyclic.members.push(cyclic);
  const result = Object.assign(() => undefined, namespaceOutcome([cyclic]).result);

  expect(enforceInspectionOutcome("export-inspection", { status: "success", result })).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("accepts recursively named namespace members in a focused Inspection Outcome", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "export-inspection",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example" },
      moduleExport: {
        name: "tools",
        spaces: [
          {
            space: "namespace",
            members: [
              {
                name: "nested",
                declarations: [],
                members: [
                  {
                    name: "useNested",
                    declarations: [
                      {
                        kind: "function",
                        text: "function useNested(): void;",
                        provenance: {
                          packageIdentity: { name: "example" },
                          file: "index.d.ts",
                          line: 1,
                          column: 1,
                        },
                      },
                    ],
                    members: [],
                  },
                ],
              },
            ],
          },
        ],
        signatures: [],
      },
      supportingTypes: [],
    },
  };

  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual(outcome);
});

it("bounds recursive namespace validation before structural decoding", () => {
  const accepted = namespaceOutcome([namespaceMemberChain(9)]);
  expect(enforceInspectionOutcome("export-inspection", accepted)).toEqual(accepted);

  expect(
    enforceInspectionOutcome("export-inspection", namespaceOutcome([namespaceMemberChain(10)])),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });

  const cyclic = namespaceMember("cyclic");
  cyclic.members.push(cyclic);
  expect(enforceInspectionOutcome("export-inspection", namespaceOutcome([cyclic]))).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("accepts a shared noncyclic namespace member", () => {
  const shared = namespaceMember("shared");
  const outcome = namespaceOutcome([
    { ...namespaceMember("left"), members: [shared] },
    { ...namespaceMember("right"), members: [shared] },
  ]);

  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual(outcome);
});

it("rejects flattened declarations in a namespace space", () => {
  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "tools",
          spaces: [
            {
              space: "namespace",
              declarations: [],
            },
          ],
          signatures: [],
        },
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects sparse arrays in a focused Inspection Outcome", () => {
  const supportingTypes: unknown[] = [];
  supportingTypes.length = 1_000_000_000;

  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "createExample",
          spaces: [],
          signatures: [],
        },
        supportingTypes,
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects non-portable declaration provenance", () => {
  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "createExample",
          spaces: [
            {
              space: "value",
              declarations: [
                {
                  kind: "function",
                  text: "function createExample(): void;",
                  provenance: {
                    packageIdentity: { name: "example" },
                    file: "../../outside.d.ts",
                    line: -4,
                    column: 0,
                  },
                },
              ],
            },
          ],
          signatures: [],
        },
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("preserves optional undefined values accepted by the process-entry protocol", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "export-inspection",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example", version: undefined },
      moduleExport: {
        name: "createExample",
        alias: undefined,
        spaces: [],
        signatures: [],
      },
      supportingTypes: [],
      packageDocumentation: undefined,
    },
  };

  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual(outcome);
});

it("derives the existing deeply readonly protocol types", () => {
  const assertReadonly = (
    packageIdentity: PackageIdentity,
    overview: InterfaceOverview,
    inspection: ExportInspection,
  ): void => {
    // @ts-expect-error Protocol fields remain readonly.
    packageIdentity.name = "changed";
    // @ts-expect-error Protocol arrays remain readonly.
    overview.moduleExports.push({ name: "changed" });
    // @ts-expect-error Public Subpaths remain readonly.
    overview.publicSubpaths.push({ specifier: "changed" });
    // @ts-expect-error Nested Protocol arrays remain readonly.
    inspection.moduleExport.spaces.push({ space: "namespace", members: [] });
  };

  type AcceptsExplicitUndefined = {
    readonly name: string;
    readonly version: undefined;
  } extends PackageIdentity
    ? true
    : false;
  type PackageIdentityHasStringIndex = string extends keyof PackageIdentity ? true : false;

  expectTypeOf(assertReadonly).toBeFunction();
  expectTypeOf<AcceptsExplicitUndefined>().toEqualTypeOf<false>();
  expectTypeOf<PackageIdentityHasStringIndex>().toEqualTypeOf<false>();
  expectTypeOf<InterfaceOverview["moduleExports"]>().toEqualTypeOf<
    readonly ModuleExportIndexEntry[]
  >();
  expectTypeOf<InterfaceOverview["publicSubpaths"]>().toEqualTypeOf<readonly PublicSubpath[]>();
  expectTypeOf<ExportInspection["moduleExport"]["spaces"]>().toEqualTypeOf<
    readonly ExportDeclarationSpace[]
  >();
  expectTypeOf<ExportNamespaceMember["members"][number]>().toEqualTypeOf<ExportNamespaceMember>();
});

interface MutableNamespaceMember {
  readonly name: string;
  readonly declarations: unknown[];
  readonly members: MutableNamespaceMember[];
}

function namespaceMember(name: string): MutableNamespaceMember {
  return { name, declarations: [], members: [] };
}

function namespaceMemberChain(memberCount: number): MutableNamespaceMember {
  let member = namespaceMember(`depth-${memberCount - 1}`);
  for (let depth = memberCount - 2; depth >= 0; depth -= 1) {
    member = { ...namespaceMember(`depth-${depth}`), members: [member] };
  }
  return member;
}

function namespaceOutcome(members: readonly MutableNamespaceMember[]) {
  return {
    status: "success",
    result: {
      intent: "export-inspection",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example" },
      moduleExport: {
        name: "tools",
        spaces: [{ space: "namespace", members }],
        signatures: [],
      },
      supportingTypes: [],
    },
  };
}
