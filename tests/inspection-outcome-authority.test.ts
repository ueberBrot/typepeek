import { describe, expect, it } from "vite-plus/test";

import {
  enforceAnalysisRequestOutcome,
  enforceInspectionOutcome,
} from "#typepeek/inspection/inspection-outcome-authority";
import type { NormalizedInspectionPlanRequest } from "#typepeek/inspection/protocol";

import { match } from "./helpers/matchers.ts";
import { defineObjectPrototypeProperty } from "./helpers/prototype-fixture.ts";

const enforceInspectionPlanOutcome = function enforceInspectionPlanOutcome(
  request: NormalizedInspectionPlanRequest,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Authority tests intentionally submit arbitrary malformed outcomes.
  value: unknown
) {
  return enforceAnalysisRequestOutcome(
    { intent: "inspection-plan", request },
    value
  );
};

const namespaceMember = function namespaceMember(
  name: string
): MutableNamespaceMember {
  return { declarations: [], members: [], name };
};

const namespaceOutcome = function namespaceOutcome(
  members: readonly MutableNamespaceMember[]
) {
  return {
    result: {
      intent: "export-inspection",
      moduleExport: {
        name: "tools",
        signatures: [],
        spaces: [{ members, space: "namespace" }],
      },
      packageIdentity: { name: "example" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
      supportingTypes: [],
    },
    status: "success",
  };
};

const namespaceMemberChain = function namespaceMemberChain(
  memberCount: number
): MutableNamespaceMember {
  let member = namespaceMember(`depth-${memberCount - 1}`);

  for (let depth = memberCount - 2; depth >= 0; depth -= 1) {
    member = { ...namespaceMember(`depth-${depth}`), members: [member] };
  }

  return member;
};

interface MutableNamespaceMember {
  readonly name: string;
  readonly declarations: unknown[];
  readonly members: MutableNamespaceMember[];
}

describe("inspection-outcome-authority", () => {
  it("validates Member evidence before request correlation for atomic and plan outcomes", () => {
    const discovery = {
      intent: "member-discovery",
      memberPath: [],
      members: [
        { name: "alpha", spaces: ["type", "value"] },
        { name: "beta", spaces: ["type"] },
      ],
      moduleExportName: "Example",
      packageIdentity: { name: "example" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
      totalMembers: 2,
    } as const;

    for (const result of [
      discovery,
      { ...discovery, members: [], totalMembers: 0 },
      { ...discovery, members: [discovery.members[0]], query: "AL" },
      { ...discovery, members: [], query: "missing" },
    ]) {
      const outcome = { result, status: "success" };
      expect(enforceInspectionOutcome(result.intent, outcome)).toStrictEqual(
        outcome
      );
    }

    const invalidResults = [
      { ...discovery, totalMembers: 1 },
      { ...discovery, totalMembers: 3 },
      { ...discovery, members: [] },
      { ...discovery, members: [discovery.members[0], discovery.members[0]] },
      { ...discovery, members: [...discovery.members].toReversed() },
      { ...discovery, query: "AL" },
      {
        ...discovery,
        members: [{ name: "alpha", spaces: ["value", "type"] }],
        totalMembers: 1,
      },
      {
        declarations: [],
        intent: "member-inspection",
        memberPath: ["alpha"],
        moduleExportName: discovery.moduleExportName,
        packageIdentity: discovery.packageIdentity,
        resolutionVariant: discovery.resolutionVariant,
        specifier: discovery.specifier,
      },
    ] as const;

    for (const result of invalidResults) {
      expect([
        enforceInspectionOutcome(result.intent, { result, status: "success" }),
        enforceInspectionOutcome("inspection-plan", {
          result: { inspections: [result], intent: "inspection-plan" },
          status: "success",
        }),
      ]).toStrictEqual([
        match.objectContaining({
          reason: "invalid-result",
          status: "unsupported",
        }),
        match.objectContaining({
          reason: "invalid-result",
          status: "unsupported",
        }),
      ]);
    }
  });

  it("rejects malformed export indexes through atomic and plan outcome validation", () => {
    const identity = {
      packageIdentity: { name: "example" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
    } as const;

    const overview = {
      ...identity,
      intent: "interface-overview",
      moduleExports: [{ name: "Alpha" }, { name: "Beta" }],
      publicSubpaths: [],
    } as const;

    const search = {
      ...identity,
      intent: "export-search",
      matches: [{ name: "Alpha" }],
      query: "aL",
      totalModuleExports: 2,
    } as const;

    const page = {
      complete: true,
      cursor: "start",
      totalModuleExports: 2,
    } as const;

    for (const result of [
      overview,
      { ...overview, exportPage: page },
      search,
      { ...search, matches: [] },
    ]) {
      const outcome = { result, status: "success" };
      expect(enforceInspectionOutcome(result.intent, outcome)).toStrictEqual(
        outcome
      );
    }

    const oversized = Array.from({ length: 321 }, (_, index) => ({
      name: `Alpha${String(index).padStart(3, "0")}`,
    }));

    const invalidResults = [
      { ...overview, moduleExports: [{ name: "Beta" }, { name: "Alpha" }] },
      { ...overview, moduleExports: [{ name: "Alpha" }, { name: "Alpha" }] },
      { ...overview, moduleExports: oversized },
      {
        ...overview,
        exportPage: page,
        moduleExports: [{ name: "Alpha" }, { name: "Alpha" }],
      },
      { ...search, totalModuleExports: 0 },
      { ...search, totalModuleExports: 16_385 },
      { ...search, matches: [{ name: "Beta" }] },
      { ...search, matches: [{ name: "Alpha" }, { name: "Alpha" }] },
      { ...search, matches: [{ name: "Alpine" }, { name: "Alpha" }] },
      { ...search, matches: oversized, totalModuleExports: 321 },
    ];

    for (const result of invalidResults) {
      expect([
        enforceInspectionOutcome(result.intent, { result, status: "success" }),
        enforceInspectionOutcome("inspection-plan", {
          result: { inspections: [result], intent: "inspection-plan" },
          status: "success",
        }),
      ]).toStrictEqual([
        match.objectContaining({
          reason: "invalid-result",
          status: "unsupported",
        }),
        match.objectContaining({
          reason: "invalid-result",
          status: "unsupported",
        }),
      ]);
    }
  });

  it.each([
    { complete: true, cursor: "start", totalModuleExports: 2 },
    { complete: false, cursor: "start", totalModuleExports: 1 },
    {
      complete: true,
      cursor: "start",
      nextCursor: `${"a".repeat(64)}.100`,
      totalModuleExports: 1,
    },
    { complete: false, cursor: `${"a".repeat(64)}.1`, totalModuleExports: 2 },
  ])("rejects inconsistent export page metadata: %j", (exportPage) => {
    expect(
      enforceInspectionOutcome("interface-overview", {
        result: {
          exportPage,
          intent: "interface-overview",
          moduleExports: [{ name: "Value" }],
          packageIdentity: { name: "example" },
          publicSubpaths: [],
          resolutionVariant: { accessStyle: "import" },
          specifier: "example",
        },
        status: "success",
      })
    ).toMatchObject({ reason: "invalid-result", status: "unsupported" });
  });

  it("correlates direct declaration and Member outcomes with their exact requests", () => {
    const declaration = {
      result: {
        intent: "declaration-inspection",
        moduleExport: {
          name: "Example",
          spaces: [
            {
              declarations: [
                {
                  kind: "interface",
                  provenance: {
                    column: 1,
                    file: "index.d.ts",
                    line: 1,
                    packageIdentity: { name: "example" },
                  },
                  text: "interface Example {}",
                },
              ],
              space: "type",
            },
          ],
        },
        packageIdentity: { name: "example" },
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
      },
      status: "success",
    } as const;

    const target = {
      accessStyle: "import",
      resolutionContext: "/repository",
      specifier: "example",
    } as const;

    expect([
      enforceAnalysisRequestOutcome(
        {
          intent: "declaration-inspection",
          request: { ...target, exportName: "Example" },
        },
        declaration
      ),
      enforceAnalysisRequestOutcome(
        {
          intent: "declaration-inspection",
          request: { ...target, exportName: "Other" },
        },
        declaration
      ),
      enforceAnalysisRequestOutcome(
        {
          intent: "declaration-inspection",
          request: { ...target, exportName: "Example", specifier: "other" },
        },
        declaration
      ),
    ]).toStrictEqual([
      declaration,
      match.objectContaining({
        status: "unsupported",
      }),
      match.objectContaining({ status: "unsupported" }),
    ]);

    const member = {
      result: {
        declarations: [
          {
            kind: "property",
            provenance: {
              column: 1,
              file: "index.d.ts",
              line: 1,
              packageIdentity: { name: "example" },
            },
            text: "value: string;",
          },
        ],
        intent: "member-inspection",
        memberPath: ["value"],
        moduleExportName: "Example",
        packageIdentity: { name: "example" },
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
      },
      status: "success",
    } as const;

    expect([
      enforceAnalysisRequestOutcome(
        {
          intent: "member-inspection",
          request: { ...target, exportName: "Example", memberPath: ["value"] },
        },
        member
      ),
      enforceAnalysisRequestOutcome(
        {
          intent: "member-inspection",
          request: { ...target, exportName: "Other", memberPath: ["value"] },
        },
        member
      ),
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
        member
      ),
    ]).toStrictEqual([
      member,
      match.objectContaining({
        status: "unsupported",
      }),
      match.objectContaining({ status: "unsupported" }),
    ]);
    const overlongPath = Array.from({ length: 17 }, () => "value");
    expect(
      enforceAnalysisRequestOutcome(
        {
          intent: "member-inspection",
          request: {
            ...target,
            exportName: "Example",
            memberPath: overlongPath,
          },
        },
        {
          ...member,
          result: { ...member.result, memberPath: overlongPath },
        }
      )
    ).toMatchObject({ status: "unsupported" });
    const oversizedPath = ["x".repeat(257)];
    expect([
      enforceAnalysisRequestOutcome(
        {
          intent: "member-inspection",
          request: {
            ...target,
            exportName: "Example",
            memberPath: oversizedPath,
          },
        },
        {
          ...member,
          result: { ...member.result, memberPath: oversizedPath },
        }
      ),
      enforceAnalysisRequestOutcome(
        {
          intent: "member-inspection",
          request: { ...target, exportName: "Example", memberPath: ["value"] },
        },
        {
          ...member,
          result: { ...member.result, declarations: [] },
        }
      ),
    ]).toStrictEqual([
      match.objectContaining({ status: "unsupported" }),
      match.objectContaining({ status: "unsupported" }),
    ]);
  });

  it("rejects a structurally incomplete successful Inspection Outcome", () => {
    expect(
      enforceInspectionOutcome("interface-overview", {
        result: {},
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects a structurally valid success for a different inspection intent", () => {
    const outcome = {
      result: {
        intent: "interface-overview",
        moduleExports: [{ name: "createExample" }],
        packageIdentity: { name: "example" },
        publicSubpaths: [],
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
      },
      status: "success",
    };

    expect(
      enforceInspectionOutcome("export-inspection", outcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("correlates every simple successful result with its complete normalized request", () => {
    const invalid = {
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    } as const;

    const overview = {
      result: {
        intent: "interface-overview",
        moduleExports: [],
        packageIdentity: { name: "other" },
        publicSubpaths: [],
        resolutionVariant: { accessStyle: "import" },
        specifier: "other",
      },
      status: "success",
    } as const;

    const search = {
      result: {
        intent: "export-search",
        matches: [],
        packageIdentity: { name: "example" },
        query: "other",
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
        totalModuleExports: 0,
      },
      status: "success",
    } as const;

    expect([
      enforceAnalysisRequestOutcome(
        {
          intent: "interface-overview",
          request: {
            accessStyle: "import",
            resolutionContext: "/repository",
            specifier: "example",
          },
        },
        overview
      ),
      enforceAnalysisRequestOutcome(
        {
          intent: "export-search",
          request: {
            accessStyle: "import",
            query: "requested",
            resolutionContext: "/repository",
            specifier: "example",
          },
        },
        search
      ),
    ]).toStrictEqual([invalid, invalid]);
  });

  it("accepts an atomic Inspection Plan result for its requested intent", () => {
    const outcome = {
      result: {
        inspections: [
          {
            intent: "interface-overview",
            moduleExports: [{ name: "createExample" }],
            packageIdentity: { name: "example" },
            publicSubpaths: [],
            resolutionVariant: { accessStyle: "import" },
            specifier: "example",
          },
        ],
        intent: "inspection-plan",
      },
      status: "success",
    } as const;

    expect([
      enforceInspectionOutcome("inspection-plan", outcome),
      enforceInspectionOutcome("interface-overview", outcome),
    ]).toStrictEqual([
      outcome,
      {
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      },
    ]);
  });

  it("enforces the complete bounded Inspection Plan result shape", () => {
    const overview = {
      intent: "interface-overview",
      moduleExports: [{ name: "createExample" }],
      packageIdentity: { name: "example" },
      publicSubpaths: [],
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
    } as const;

    const plan = (
      inspections: readonly (typeof overview)[],
      extra: { readonly extra?: boolean } = {}
    ) => ({
      result: { inspections, intent: "inspection-plan", ...extra },
      status: "success",
    });

    const invalid = {
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    };

    expect([
      enforceInspectionOutcome("inspection-plan", plan([])),
      enforceInspectionOutcome("inspection-plan", plan([overview])),
      enforceInspectionOutcome(
        "inspection-plan",
        plan(Array.from({ length: 16 }, () => overview))
      ),
      enforceInspectionOutcome(
        "inspection-plan",
        plan(Array.from({ length: 17 }, () => overview))
      ),
      enforceInspectionOutcome(
        "inspection-plan",
        plan([overview], { extra: true })
      ),
    ]).toStrictEqual([
      invalid,
      plan([overview]),
      plan(Array.from({ length: 16 }, () => overview)),
      invalid,
      invalid,
    ]);
  });

  it("rejects inherited Inspection Outcome accessors without evaluating them", () => {
    let statusRead = false;

    const outcome = {
      result: { inspections: [], intent: "inspection-plan" },
    };

    Object.setPrototypeOf(outcome, {
      get status() {
        statusRead = true;

        return "success";
      },
    });
    expect([
      enforceInspectionOutcome("inspection-plan", outcome),
      statusRead,
    ]).toStrictEqual([
      {
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      },
      false,
    ]);
  });

  it("does not read Inspection Outcome fields inherited from Object.prototype", () => {
    let statusRead = false;
    let enforced: ReturnType<typeof enforceInspectionOutcome>;
    defineObjectPrototypeProperty("status", {
      configurable: true,
      get() {
        statusRead = true;

        return "success";
      },
    });

    try {
      enforced = enforceInspectionOutcome("inspection-plan", {
        result: { inspections: [], intent: "inspection-plan" },
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "status");
    }

    expect([enforced, statusRead]).toStrictEqual([
      {
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      },
      false,
    ]);
  });

  it("does not read omitted decoded identity fields from Object.prototype", () => {
    const request = {
      accessStyle: "import",
      queries: [
        { intent: "interface-overview" },
        { exportName: "createExample", intent: "signature-inspection" },
      ],
      resolutionContext: "/repository",
      specifier: "example",
    } as const;

    const outcome = {
      result: {
        inspections: [
          {
            intent: "interface-overview",
            moduleExports: [{ name: "createExample" }],
            packageIdentity: { name: "example" },
            publicSubpaths: [],
            resolutionVariant: { accessStyle: "import" },
            specifier: "example",
          },
          {
            intent: "signature-inspection",
            moduleExport: { name: "createExample", signatures: [] },
            packageIdentity: { name: "example" },
            resolutionVariant: { accessStyle: "import" },
            specifier: "example",
          },
        ],
        intent: "inspection-plan",
      },
      status: "success",
    } as const;

    let versionRead = false;
    let enforced: ReturnType<typeof enforceInspectionPlanOutcome>;
    defineObjectPrototypeProperty("version", {
      configurable: true,
      get() {
        versionRead = true;
        throw new Error("inherited version evaluated");
      },
    });

    try {
      enforced = enforceInspectionPlanOutcome(request, outcome);
    } finally {
      Reflect.deleteProperty(Object.prototype, "version");
    }

    expect([enforced, versionRead]).toStrictEqual([outcome, false]);
  });

  it("rejects a plan result that omits or reorders requested inspections", () => {
    const overview = {
      intent: "interface-overview",
      moduleExports: [{ name: "createExample" }],
      packageIdentity: { name: "example" },
      publicSubpaths: [],
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
    } as const;

    const signatures = {
      intent: "signature-inspection",
      moduleExport: { name: "createExample", signatures: [] },
      packageIdentity: { name: "example" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
    } as const;

    const queries = [
      { intent: "interface-overview" },
      { exportName: "createExample", intent: "signature-inspection" },
    ] as const;

    const invalid = {
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    } as const;

    expect([
      enforceInspectionPlanOutcome(
        {
          accessStyle: "import",
          queries,
          resolutionContext: "/repository",
          specifier: "example",
        },
        {
          result: { inspections: [overview], intent: "inspection-plan" },
          status: "success",
        }
      ),
      enforceInspectionPlanOutcome(
        {
          accessStyle: "import",
          queries: [{ intent: "interface-overview" }],
          resolutionContext: "/repository",
          specifier: "requested",
        },
        {
          result: { inspections: [overview], intent: "inspection-plan" },
          status: "success",
        }
      ),
      enforceInspectionPlanOutcome(
        {
          accessStyle: "import",
          queries,
          resolutionContext: "/repository",
          specifier: "example",
        },
        {
          result: {
            inspections: [
              overview,
              {
                ...signatures,
                packageIdentity: { name: "different-evidence" },
              },
            ],
            intent: "inspection-plan",
          },
          status: "success",
        }
      ),
      enforceInspectionPlanOutcome(
        {
          accessStyle: "import",
          queries,
          resolutionContext: "/repository",
          specifier: "example",
        },
        {
          result: {
            inspections: [signatures, overview],
            intent: "inspection-plan",
          },
          status: "success",
        }
      ),
    ]).toStrictEqual([invalid, invalid, invalid, invalid]);

    const search = {
      intent: "export-search",
      matches: [],
      packageIdentity: { name: "example" },
      query: "different",
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
      totalModuleExports: 1,
    } as const;

    expect(
      enforceInspectionPlanOutcome(
        {
          accessStyle: "import",
          queries: [{ intent: "export-search", query: "requested" }],
          resolutionContext: "/repository",
          specifier: "example",
        },
        {
          result: { inspections: [search], intent: "inspection-plan" },
          status: "success",
        }
      )
    ).toStrictEqual(invalid);

    const member = {
      declarations: [
        {
          kind: "property",
          provenance: {
            column: 1,
            file: "index.d.ts",
            line: 1,
            packageIdentity: { name: "example" },
          },
          text: "actual: string;",
        },
      ],
      intent: "member-inspection",
      memberPath: ["actual"],
      moduleExportName: "Example",
      packageIdentity: { name: "example" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
    } as const;

    expect(
      enforceInspectionPlanOutcome(
        {
          accessStyle: "import",
          queries: [
            {
              exportName: "Example",
              intent: "member-inspection",
              memberPath: ["requested"],
            },
          ],
          resolutionContext: "/repository",
          specifier: "example",
        },
        {
          result: { inspections: [member], intent: "inspection-plan" },
          status: "success",
        }
      )
    ).toStrictEqual(invalid);
  });

  it("accepts a provider-backed Platform Module without a Package Identity", () => {
    const outcome = {
      result: {
        declarationProvider: { name: "@types/node", version: "24.13.3" },
        intent: "interface-overview",
        moduleExports: [{ name: "readFile" }],
        publicSubpaths: [],
        resolutionVariant: { accessStyle: "import" },
        specifier: "node:fs",
      },
      status: "success",
    } as const;

    expect(
      enforceInspectionOutcome("interface-overview", outcome)
    ).toStrictEqual(outcome);
  });

  it("rejects a successful result without an evidence identity", () => {
    expect(
      enforceInspectionOutcome("interface-overview", {
        result: {
          intent: "interface-overview",
          moduleExports: [],
          publicSubpaths: [],
          specifier: "identity-free",
        },
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it.each([
    { reason: "specifier-not-found", status: "not-found" },
    { reason: "unsupported-evidence", status: "unsupported" },
    { reason: "static-boundary", status: "static-boundary" },
    {
      exceededBudget: "analysis-output-bytes",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    },
  ] as const)(
    "preserves an intent-neutral %s Inspection Failure",
    (failure) => {
      const outcome = {
        ...failure,
        message: `${failure.status} outcome`,
      } as const;

      expect([
        enforceInspectionOutcome("interface-overview", outcome),
        enforceInspectionOutcome("export-inspection", outcome),
        enforceInspectionOutcome("signature-inspection", outcome),
      ]).toStrictEqual([outcome, outcome, outcome]);
    }
  );

  it("accepts only the bounded Signature Inspection result shape", () => {
    const outcome = {
      result: {
        intent: "signature-inspection",
        moduleExport: {
          aliasTargetName: "buildExample",
          name: "createExample",
          signatures: [
            {
              kind: "call",
              parameters: [
                {
                  binding: {
                    kind: "identifier",
                    name: "input",
                    synthetic: false,
                  },
                  optional: false,
                  rest: false,
                  type: "string",
                },
              ],
              returns: { kind: "type", type: "number" },
              text: "(input: string): number",
              typeParameters: [],
            },
          ],
        },
        packageIdentity: { name: "example", version: "1.0.0" },
        resolutionVariant: { accessStyle: "require" },
        specifier: "example",
      },
      status: "success",
    } as const;

    expect([
      enforceInspectionOutcome("signature-inspection", outcome),
      enforceInspectionOutcome("signature-inspection", {
        ...outcome,
        result: {
          ...outcome.result,
          supportingTypes: [],
        },
      }),
      enforceInspectionOutcome("signature-inspection", {
        ...outcome,
        result: {
          ...outcome.result,
          moduleExport: {
            ...outcome.result.moduleExport,
            signatures: outcome.result.moduleExport.signatures.map(
              (signature) =>
                Object.fromEntries(
                  Object.entries(signature).filter(([key]) => key !== "returns")
                )
            ),
          },
        },
      }),
    ]).toStrictEqual([
      outcome,
      {
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      },
      {
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      },
    ]);
  });

  it("bounds protocol graph validation before structural schema checking", () => {
    expect(
      enforceInspectionOutcome("interface-overview", {
        result: {
          intent: "interface-overview",
          moduleExports: Array.from({ length: 4097 }, (_, index) => ({
            name: `item${index}`,
          })),
          packageIdentity: { name: "example" },
          publicSubpaths: [],
          specifier: "example",
        },
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects compiler-shaped data in a focused Inspection Outcome", () => {
    const spaces = Object.assign(
      [
        {
          declarations: [
            {
              kind: "function",
              provenance: {
                column: 1,
                file: "index.d.ts",
                line: 1,
                packageIdentity: { name: "example" },
              },
              text: "function createExample(): void;",
            },
          ],
          space: "value",
        },
      ],
      { compilerNode: { flags: 1 } }
    );

    expect(
      enforceInspectionOutcome("export-inspection", {
        result: {
          intent: "export-inspection",
          moduleExport: {
            name: "createExample",
            signatures: [],
            spaces,
          },
          packageIdentity: { name: "example" },
          specifier: "example",
          supportingTypes: [],
        },
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects arrays with shadowed traversal methods without calling them", () => {
    const members = [namespaceMember("nested")];
    Object.defineProperty(members, "every", {
      enumerable: true,
      value: null,
    });
    expect(
      enforceInspectionOutcome("export-inspection", namespaceOutcome(members))
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
    const outcome = namespaceOutcome([namespaceMember("nested")]);
    Object.defineProperty(outcome.result.moduleExport.spaces, "every", {
      enumerable: true,
      value: null,
    });
    expect(
      enforceInspectionOutcome("export-inspection", outcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects accessor properties without evaluating them", () => {
    const outcome = {
      message: "missing",
      status: "not-found",
    };

    Object.defineProperty(outcome, "extra", {
      enumerable: true,
      get() {
        throw new Error("getter was evaluated");
      },
    });
    expect(
      enforceInspectionOutcome("interface-overview", outcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("contains throwing accessors on non-record outcome inputs", () => {
    const outcome: unknown[] = [];
    Object.defineProperties(outcome, {
      message: {
        get() {
          throw new Error("outcome getter was evaluated");
        },
      },
      status: { value: "not-found" },
    });
    expect(
      enforceInspectionOutcome("interface-overview", outcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects arrays and functions masquerading as Inspection Outcome records", () => {
    const arrayOutcome: unknown[] = [];
    Object.setPrototypeOf(arrayOutcome, {
      message: "missing",
      status: "not-found",
    });
    expect(
      enforceInspectionOutcome("interface-overview", arrayOutcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });

    const functionOutcome = Object.assign(() => {}, {
      message: "missing",
      status: "not-found",
    });

    expect(
      enforceInspectionOutcome("interface-overview", functionOutcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("does not let a function-shaped result bypass recursive namespace bounds", () => {
    const cyclic = namespaceMember("cyclic");
    cyclic.members.push(cyclic);
    const result = Object.assign(() => {}, namespaceOutcome([cyclic]).result);
    expect(
      enforceInspectionOutcome("export-inspection", {
        result,
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("accepts recursively named namespace members in a focused Inspection Outcome", () => {
    const outcome = {
      result: {
        intent: "export-inspection",
        moduleExport: {
          name: "tools",
          signatures: [],
          spaces: [
            {
              members: [
                {
                  declarations: [],
                  members: [
                    {
                      declarations: [
                        {
                          kind: "function",
                          provenance: {
                            column: 1,
                            file: "index.d.ts",
                            line: 1,
                            packageIdentity: { name: "example" },
                          },
                          text: "function useNested(): void;",
                        },
                      ],
                      members: [],
                      name: "useNested",
                    },
                  ],
                  name: "nested",
                },
              ],
              space: "namespace",
            },
          ],
        },
        packageIdentity: { name: "example" },
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
        supportingTypes: [],
      },
      status: "success",
    };

    expect(
      enforceInspectionOutcome("export-inspection", outcome)
    ).toStrictEqual(outcome);
  });

  it("bounds recursive namespace validation before structural decoding", () => {
    const accepted = namespaceOutcome([namespaceMemberChain(9)]);
    expect([
      enforceInspectionOutcome("export-inspection", accepted),
      enforceInspectionOutcome(
        "export-inspection",
        namespaceOutcome([namespaceMemberChain(10)])
      ),
    ]).toStrictEqual([
      accepted,
      {
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      },
    ]);
    const cyclic = namespaceMember("cyclic");
    cyclic.members.push(cyclic);
    expect(
      enforceInspectionOutcome("export-inspection", namespaceOutcome([cyclic]))
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("accepts a shared noncyclic namespace member", () => {
    const shared = namespaceMember("shared");

    const outcome = namespaceOutcome([
      { ...namespaceMember("left"), members: [shared] },
      { ...namespaceMember("right"), members: [shared] },
    ]);

    expect(
      enforceInspectionOutcome("export-inspection", outcome)
    ).toStrictEqual(outcome);
  });

  it.each(["declaration-inspection", "inspection-plan"] as const)(
    "bounds declaration namespace depth in %s outcomes",
    (intent) => {
      const outcomeAtDepth = (depth: number) => {
        const focused = namespaceOutcome([namespaceMemberChain(depth)]).result;

        const declaration = {
          intent: "declaration-inspection",
          moduleExport: {
            name: focused.moduleExport.name,
            spaces: focused.moduleExport.spaces,
          },
          packageIdentity: focused.packageIdentity,
          resolutionVariant: focused.resolutionVariant,
          specifier: focused.specifier,
        };

        return {
          result:
            intent === "inspection-plan"
              ? { inspections: [declaration], intent }
              : declaration,
          status: "success",
        };
      };

      const accepted = outcomeAtDepth(9);
      expect([
        enforceInspectionOutcome(intent, accepted),
        enforceInspectionOutcome(intent, outcomeAtDepth(10)),
      ]).toStrictEqual([
        accepted,
        {
          message: "Inspection returned an invalid result.",
          reason: "invalid-result",
          status: "unsupported",
        },
      ]);
    }
  );

  it("rejects flattened declarations in a namespace space", () => {
    expect(
      enforceInspectionOutcome("export-inspection", {
        result: {
          intent: "export-inspection",
          moduleExport: {
            name: "tools",
            signatures: [],
            spaces: [
              {
                declarations: [],
                space: "namespace",
              },
            ],
          },
          packageIdentity: { name: "example" },
          specifier: "example",
          supportingTypes: [],
        },
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects sparse arrays in a focused Inspection Outcome", () => {
    const supportingTypes: unknown[] = [];
    supportingTypes.length = 1_000_000_000;
    expect(
      enforceInspectionOutcome("export-inspection", {
        result: {
          intent: "export-inspection",
          moduleExport: {
            name: "createExample",
            signatures: [],
            spaces: [],
          },
          packageIdentity: { name: "example" },
          specifier: "example",
          supportingTypes,
        },
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects non-portable declaration provenance", () => {
    expect(
      enforceInspectionOutcome("export-inspection", {
        result: {
          intent: "export-inspection",
          moduleExport: {
            name: "createExample",
            signatures: [],
            spaces: [
              {
                declarations: [
                  {
                    kind: "function",
                    provenance: {
                      column: 0,
                      file: "../../outside.d.ts",
                      line: -4,
                      packageIdentity: { name: "example" },
                    },
                    text: "function createExample(): void;",
                  },
                ],
                space: "value",
              },
            ],
          },
          packageIdentity: { name: "example" },
          specifier: "example",
          supportingTypes: [],
        },
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("rejects explicit undefined where the process-entry schema requires omission", () => {
    const outcome = {
      result: {
        intent: "export-inspection",
        moduleExport: {
          ...Object.fromEntries([["alias", undefined]]),
          name: "createExample",
          signatures: [],
          spaces: [],
        },
        ...Object.fromEntries([["packageDocumentation", undefined]]),
        packageIdentity: {
          name: "example",
          ...Object.fromEntries([["version", undefined]]),
        },
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
        supportingTypes: [],
      },
      status: "success",
    };

    expect(
      enforceInspectionOutcome("export-inspection", outcome)
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  it("correlates qualified Member Discovery selectors, searches, and ordered plan outcomes", () => {
    const target = {
      accessStyle: "import",
      resolutionContext: "/repository",
      specifier: "example",
    } as const;

    const query = {
      exportName: "Example",
      intent: "member-discovery",
      memberPath: [{ name: "nested", space: "type" }],
      query: "VaL",
    } as const;

    const result = {
      intent: "member-discovery",
      memberPath: [{ name: "nested", space: "type" }],
      members: [{ name: "value", spaces: ["type", "value"] }],
      moduleExportName: "Example",
      packageIdentity: { name: "example" },
      query: "VaL",
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
      totalMembers: 4,
    } as const;

    const outcome = { result, status: "success" } as const;
    expect(
      enforceAnalysisRequestOutcome(
        { intent: query.intent, request: { ...target, ...query } },
        outcome
      )
    ).toStrictEqual(outcome);

    const wrongResults = [
      { ...result, memberPath: ["nested"] },
      { ...result, memberPath: [{ name: "nested", space: "value" }] },
      { ...result, moduleExportName: "Other" },
      { ...result, query: "val" },
      { ...result, totalMembers: 0 },
      { ...result, members: [{ name: "missing", spaces: ["type"] }] },
      { ...result, members: [{ name: "value", spaces: ["value", "type"] }] },
      {
        ...result,
        members: [
          { name: "value", spaces: ["type"] },
          { name: "value", spaces: ["value"] },
        ],
      },
    ];

    for (const wrong of wrongResults) {
      expect([
        enforceAnalysisRequestOutcome(
          { intent: query.intent, request: { ...target, ...query } },
          { result: wrong, status: "success" }
        ),
        enforceInspectionPlanOutcome(
          { ...target, queries: [query] },
          {
            result: { inspections: [wrong], intent: "inspection-plan" },
            status: "success",
          }
        ),
      ]).toStrictEqual([
        match.objectContaining({
          reason: "invalid-result",
          status: "unsupported",
        }),
        match.objectContaining({
          reason: "invalid-result",
          status: "unsupported",
        }),
      ]);
    }

    const empty = { result: { ...result, members: [] }, status: "success" };
    expect(
      enforceAnalysisRequestOutcome(
        { intent: query.intent, request: { ...target, ...query } },
        empty
      )
    ).toStrictEqual(empty);
  });
});
