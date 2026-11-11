import { expect, test } from "vite-plus/test";

import { enforceInspectionOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";

import { match } from "../helpers/matchers.ts";

export const registerResultContractTests =
  function registerResultContractTests(): void {
    test("validates Member evidence before request correlation for atomic and plan outcomes", () => {
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
          enforceInspectionOutcome(result.intent, {
            result,
            status: "success",
          }),
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

    test("rejects malformed export indexes through atomic and plan outcome validation", () => {
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
          enforceInspectionOutcome(result.intent, {
            result,
            status: "success",
          }),
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

    test.each([
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

    test("enforces the complete bounded Inspection Plan result shape", () => {
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

    test("accepts a provider-backed Platform Module without a Package Identity", () => {
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

    test("rejects a successful result without an evidence identity", () => {
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

    test.each([
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

    test("accepts only the bounded Signature Inspection result shape", () => {
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
                    Object.entries(signature).filter(
                      ([key]) => key !== "returns"
                    )
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

    test("rejects non-portable declaration provenance", () => {
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

    test("rejects explicit undefined where the process-entry schema requires omission", () => {
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
  };
