import { expect, it } from "vite-plus/test";

import {
  enforceAnalysisRequestOutcome,
  enforceInspectionOutcome,
} from "#typepeek/inspection/inspection-outcome-authority";
import { type NormalizedInspectionPlanRequest } from "#typepeek/inspection/protocol";

function enforceInspectionPlanOutcome(request: NormalizedInspectionPlanRequest, value: unknown) {
  return enforceAnalysisRequestOutcome({ intent: "inspection-plan", request }, value);
}

it("correlates direct declaration and Member outcomes with their exact requests", () => {
  const declaration = {
    status: "success",
    result: {
      intent: "declaration-inspection",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example" },
      moduleExport: {
        name: "Example",
        spaces: [
          {
            space: "type",
            declarations: [
              {
                kind: "interface",
                text: "interface Example {}",
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
      },
    },
  } as const;
  const target = {
    resolutionContext: "/repository",
    specifier: "example",
    accessStyle: "import",
  } as const;
  expect(
    enforceAnalysisRequestOutcome(
      { intent: "declaration-inspection", request: { ...target, exportName: "Example" } },
      declaration,
    ),
  ).toEqual(declaration);
  expect(
    enforceAnalysisRequestOutcome(
      { intent: "declaration-inspection", request: { ...target, exportName: "Other" } },
      declaration,
    ),
  ).toMatchObject({
    status: "unsupported",
  });
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "declaration-inspection",
        request: { ...target, specifier: "other", exportName: "Example" },
      },
      declaration,
    ),
  ).toMatchObject({ status: "unsupported" });

  const member = {
    status: "success",
    result: {
      intent: "member-inspection",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example" },
      moduleExportName: "Example",
      memberPath: ["value"],
      declarations: [
        {
          kind: "property",
          text: "value: string;",
          provenance: {
            packageIdentity: { name: "example" },
            file: "index.d.ts",
            line: 1,
            column: 1,
          },
        },
      ],
    },
  } as const;
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "member-inspection",
        request: { ...target, exportName: "Example", memberPath: ["value"] },
      },
      member,
    ),
  ).toEqual(member);
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "member-inspection",
        request: { ...target, exportName: "Other", memberPath: ["value"] },
      },
      member,
    ),
  ).toMatchObject({
    status: "unsupported",
  });
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "member-inspection",
        request: {
          ...target,
          accessStyle: "require",
          exportName: "Example",
          memberPath: ["value"],
        },
      },
      member,
    ),
  ).toMatchObject({ status: "unsupported" });
  const overlongPath = Array.from({ length: 17 }, () => "value");
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "member-inspection",
        request: { ...target, exportName: "Example", memberPath: overlongPath },
      },
      {
        ...member,
        result: { ...member.result, memberPath: overlongPath },
      },
    ),
  ).toMatchObject({ status: "unsupported" });
  const oversizedPath = ["x".repeat(257)];
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "member-inspection",
        request: { ...target, exportName: "Example", memberPath: oversizedPath },
      },
      {
        ...member,
        result: { ...member.result, memberPath: oversizedPath },
      },
    ),
  ).toMatchObject({ status: "unsupported" });
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "member-inspection",
        request: { ...target, exportName: "Example", memberPath: ["value"] },
      },
      {
        ...member,
        result: { ...member.result, declarations: [] },
      },
    ),
  ).toMatchObject({ status: "unsupported" });
});

it("rejects a structurally incomplete successful Inspection Outcome", () => {
  expect(
    enforceInspectionOutcome("interface-overview", {
      status: "success",
      result: {},
    }),
  ).toEqual({
    status: "unsupported",
    reason: "invalid-result",
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
});

it("correlates every simple successful result with its complete normalized request", () => {
  const invalid = {
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  } as const;
  const overview = {
    status: "success",
    result: {
      intent: "interface-overview",
      specifier: "other",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "other" },
      publicSubpaths: [],
      moduleExports: [],
    },
  } as const;
  const search = {
    status: "success",
    result: {
      intent: "export-search",
      specifier: "example",
      resolutionVariant: { accessStyle: "import" },
      packageIdentity: { name: "example" },
      query: "other",
      totalModuleExports: 0,
      matches: [],
    },
  } as const;

  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "interface-overview",
        request: {
          resolutionContext: "/repository",
          specifier: "example",
          accessStyle: "import",
        },
      },
      overview,
    ),
  ).toEqual(invalid);
  expect(
    enforceAnalysisRequestOutcome(
      {
        intent: "export-search",
        request: {
          resolutionContext: "/repository",
          specifier: "example",
          accessStyle: "import",
          query: "requested",
        },
      },
      search,
    ),
  ).toEqual(invalid);
});

it("accepts an atomic Inspection Plan result for its requested intent", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "inspection-plan",
      inspections: [
        {
          intent: "interface-overview",
          specifier: "example",
          resolutionVariant: { accessStyle: "import" },
          packageIdentity: { name: "example" },
          publicSubpaths: [],
          moduleExports: [{ name: "createExample" }],
        },
      ],
    },
  } as const;

  expect(enforceInspectionOutcome("inspection-plan", outcome)).toEqual(outcome);
  expect(enforceInspectionOutcome("interface-overview", outcome)).toEqual({
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
});

it("enforces the complete bounded Inspection Plan result shape", () => {
  const overview = {
    intent: "interface-overview",
    specifier: "example",
    resolutionVariant: { accessStyle: "import" },
    packageIdentity: { name: "example" },
    publicSubpaths: [],
    moduleExports: [{ name: "createExample" }],
  } as const;
  const plan = (inspections: readonly unknown[], extra: Record<string, unknown> = {}) => ({
    status: "success",
    result: { intent: "inspection-plan", inspections, ...extra },
  });
  const invalid = {
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  };

  expect(enforceInspectionOutcome("inspection-plan", plan([]))).toEqual(invalid);
  expect(enforceInspectionOutcome("inspection-plan", plan([overview]))).toEqual(plan([overview]));
  expect(enforceInspectionOutcome("inspection-plan", plan(Array(16).fill(overview)))).toEqual(
    plan(Array(16).fill(overview)),
  );
  expect(enforceInspectionOutcome("inspection-plan", plan(Array(17).fill(overview)))).toEqual(
    invalid,
  );
  expect(enforceInspectionOutcome("inspection-plan", plan([overview], { extra: true }))).toEqual(
    invalid,
  );
});

it("rejects inherited Inspection Outcome accessors without evaluating them", () => {
  let statusRead = false;
  const outcome = Object.create({
    get status() {
      statusRead = true;
      return "success";
    },
  }) as Record<string, unknown>;
  outcome["result"] = {
    intent: "inspection-plan",
    inspections: [],
  };

  expect(enforceInspectionOutcome("inspection-plan", outcome)).toEqual({
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
  expect(statusRead).toBe(false);
});

it("does not read Inspection Outcome fields inherited from Object.prototype", () => {
  let statusRead = false;
  let enforced: ReturnType<typeof enforceInspectionOutcome>;
  Object.defineProperty(Object.prototype, "status", {
    configurable: true,
    get() {
      statusRead = true;
      return "success";
    },
  });
  try {
    enforced = enforceInspectionOutcome("inspection-plan", {
      result: { intent: "inspection-plan", inspections: [] },
    });
  } finally {
    delete (Object.prototype as { status?: unknown }).status;
  }

  expect(enforced).toEqual({
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
  expect(statusRead).toBe(false);
});

it("does not read omitted decoded identity fields from Object.prototype", () => {
  const request = {
    resolutionContext: "/repository",
    specifier: "example",
    accessStyle: "import",
    queries: [
      { intent: "interface-overview" },
      { intent: "signature-inspection", exportName: "createExample" },
    ],
  } as const;
  const outcome = {
    status: "success",
    result: {
      intent: "inspection-plan",
      inspections: [
        {
          intent: "interface-overview",
          specifier: "example",
          resolutionVariant: { accessStyle: "import" },
          packageIdentity: { name: "example" },
          publicSubpaths: [],
          moduleExports: [{ name: "createExample" }],
        },
        {
          intent: "signature-inspection",
          specifier: "example",
          resolutionVariant: { accessStyle: "import" },
          packageIdentity: { name: "example" },
          moduleExport: { name: "createExample", signatures: [] },
        },
      ],
    },
  } as const;
  let versionRead = false;
  let enforced: ReturnType<typeof enforceInspectionPlanOutcome>;
  Object.defineProperty(Object.prototype, "version", {
    configurable: true,
    get() {
      versionRead = true;
      throw new Error("inherited version evaluated");
    },
  });
  try {
    enforced = enforceInspectionPlanOutcome(request, outcome);
  } finally {
    delete (Object.prototype as { version?: unknown }).version;
  }

  expect(enforced).toEqual(outcome);
  expect(versionRead).toBe(false);
});

it("rejects a plan result that omits or reorders requested inspections", () => {
  const overview = {
    intent: "interface-overview",
    specifier: "example",
    resolutionVariant: { accessStyle: "import" },
    packageIdentity: { name: "example" },
    publicSubpaths: [],
    moduleExports: [{ name: "createExample" }],
  } as const;
  const signatures = {
    intent: "signature-inspection",
    specifier: "example",
    resolutionVariant: { accessStyle: "import" },
    packageIdentity: { name: "example" },
    moduleExport: { name: "createExample", signatures: [] },
  } as const;
  const queries = [
    { intent: "interface-overview" },
    { intent: "signature-inspection", exportName: "createExample" },
  ] as const;
  const invalid = {
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  } as const;

  expect(
    enforceInspectionPlanOutcome(
      {
        resolutionContext: "/repository",
        specifier: "example",
        accessStyle: "import",
        queries,
      },
      {
        status: "success",
        result: { intent: "inspection-plan", inspections: [overview] },
      },
    ),
  ).toEqual(invalid);
  expect(
    enforceInspectionPlanOutcome(
      {
        resolutionContext: "/repository",
        specifier: "requested",
        accessStyle: "import",
        queries: [{ intent: "interface-overview" }],
      },
      {
        status: "success",
        result: { intent: "inspection-plan", inspections: [overview] },
      },
    ),
  ).toEqual(invalid);
  expect(
    enforceInspectionPlanOutcome(
      {
        resolutionContext: "/repository",
        specifier: "example",
        accessStyle: "import",
        queries,
      },
      {
        status: "success",
        result: {
          intent: "inspection-plan",
          inspections: [
            overview,
            { ...signatures, packageIdentity: { name: "different-evidence" } },
          ],
        },
      },
    ),
  ).toEqual(invalid);
  expect(
    enforceInspectionPlanOutcome(
      {
        resolutionContext: "/repository",
        specifier: "example",
        accessStyle: "import",
        queries,
      },
      {
        status: "success",
        result: { intent: "inspection-plan", inspections: [signatures, overview] },
      },
    ),
  ).toEqual(invalid);

  const search = {
    intent: "export-search",
    specifier: "example",
    resolutionVariant: { accessStyle: "import" },
    packageIdentity: { name: "example" },
    query: "different",
    totalModuleExports: 1,
    matches: [],
  } as const;
  expect(
    enforceInspectionPlanOutcome(
      {
        resolutionContext: "/repository",
        specifier: "example",
        accessStyle: "import",
        queries: [{ intent: "export-search", query: "requested" }],
      },
      {
        status: "success",
        result: { intent: "inspection-plan", inspections: [search] },
      },
    ),
  ).toEqual(invalid);

  const member = {
    intent: "member-inspection",
    specifier: "example",
    resolutionVariant: { accessStyle: "import" },
    packageIdentity: { name: "example" },
    moduleExportName: "Example",
    memberPath: ["actual"],
    declarations: [
      {
        kind: "property",
        text: "actual: string;",
        provenance: {
          packageIdentity: { name: "example" },
          file: "index.d.ts",
          line: 1,
          column: 1,
        },
      },
    ],
  } as const;
  expect(
    enforceInspectionPlanOutcome(
      {
        resolutionContext: "/repository",
        specifier: "example",
        accessStyle: "import",
        queries: [
          { intent: "member-inspection", exportName: "Example", memberPath: ["requested"] },
        ],
      },
      {
        status: "success",
        result: { intent: "inspection-plan", inspections: [member] },
      },
    ),
  ).toEqual(invalid);
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
});

it.each([
  { status: "not-found", reason: "specifier-not-found" },
  { status: "unsupported", reason: "unsupported-evidence" },
  { status: "static-boundary", reason: "static-boundary" },
  {
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "analysis-output-bytes",
  },
] as const)("preserves an intent-neutral %s Inspection Failure", (failure) => {
  const outcome = {
    ...failure,
    message: `${failure.status} outcome`,
  } as const;

  expect(enforceInspectionOutcome("interface-overview", outcome)).toEqual(outcome);
  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual(outcome);
  expect(enforceInspectionOutcome("signature-inspection", outcome)).toEqual(outcome);
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
    reason: "invalid-result",
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
    reason: "invalid-result",
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
    reason: "invalid-result",
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
    reason: "invalid-result",
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });

  const outcome = namespaceOutcome([namespaceMember("nested")]);
  Object.defineProperty(outcome.result.moduleExport.spaces, "every", {
    value: null,
    enumerable: true,
  });
  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual({
    status: "unsupported",
    reason: "invalid-result",
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
});

it("contains throwing accessors on non-record outcome inputs", () => {
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });

  const functionOutcome = Object.assign(() => undefined, {
    status: "not-found",
    message: "missing",
  });
  expect(enforceInspectionOutcome("interface-overview", functionOutcome)).toEqual({
    status: "unsupported",
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });
});

it("does not let a function-shaped result bypass recursive namespace bounds", () => {
  const cyclic = namespaceMember("cyclic");
  cyclic.members.push(cyclic);
  const result = Object.assign(() => undefined, namespaceOutcome([cyclic]).result);

  expect(enforceInspectionOutcome("export-inspection", { status: "success", result })).toEqual({
    status: "unsupported",
    reason: "invalid-result",
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
    reason: "invalid-result",
    message: "Inspection returned an invalid result.",
  });

  const cyclic = namespaceMember("cyclic");
  cyclic.members.push(cyclic);
  expect(enforceInspectionOutcome("export-inspection", namespaceOutcome([cyclic]))).toEqual({
    status: "unsupported",
    reason: "invalid-result",
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
    reason: "invalid-result",
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
    reason: "invalid-result",
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
    reason: "invalid-result",
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
