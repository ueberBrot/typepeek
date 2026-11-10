import { expect, test } from "vite-plus/test";

import { enforceInspectionOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";

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

export const registerNamespaceGraphTests =
  function registerNamespaceGraphTests(): void {
    test("rejects arrays with shadowed traversal methods without calling them", () => {
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

    test("does not let a function-shaped result bypass recursive namespace bounds", () => {
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

    test("accepts recursively named namespace members in a focused Inspection Outcome", () => {
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

    test("bounds recursive namespace validation before structural decoding", () => {
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
        enforceInspectionOutcome(
          "export-inspection",
          namespaceOutcome([cyclic])
        )
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });

    test("accepts a shared noncyclic namespace member", () => {
      const shared = namespaceMember("shared");

      const outcome = namespaceOutcome([
        { ...namespaceMember("left"), members: [shared] },
        { ...namespaceMember("right"), members: [shared] },
      ]);

      expect(
        enforceInspectionOutcome("export-inspection", outcome)
      ).toStrictEqual(outcome);
    });

    test.each(["declaration-inspection", "inspection-plan"] as const)(
      "bounds declaration namespace depth in %s outcomes",
      (intent) => {
        const outcomeAtDepth = (depth: number) => {
          const focused = namespaceOutcome([
            namespaceMemberChain(depth),
          ]).result;

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

    test("rejects flattened declarations in a namespace space", () => {
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
  };
