import { expect, test } from "vite-plus/test";

import {
  enforceAnalysisRequestOutcome,
  enforceInspectionOutcome,
} from "#typepeek/inspection/inspection-outcome-authority";
import type { NormalizedInspectionPlanRequest } from "#typepeek/inspection/protocol";

import { match } from "../helpers/matchers.ts";
import { defineObjectPrototypeProperty } from "../helpers/prototype-fixture.ts";

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

export const registerRequestCorrelationTests =
  function registerRequestCorrelationTests(): void {
    test("correlates direct declaration and Member outcomes with their exact requests", () => {
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
            request: {
              ...target,
              exportName: "Example",
              memberPath: ["value"],
            },
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
            request: {
              ...target,
              exportName: "Example",
              memberPath: ["value"],
            },
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

    test("rejects a structurally valid success for a different inspection intent", () => {
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

    test("correlates every simple successful result with its complete normalized request", () => {
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

    test("accepts an atomic Inspection Plan result for its requested intent", () => {
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

    test("does not read omitted decoded identity fields from Object.prototype", () => {
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

    test("rejects a plan result that omits or reorders requested inspections", () => {
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

    test("correlates qualified Member Discovery selectors, searches, and ordered plan outcomes", () => {
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
  };
