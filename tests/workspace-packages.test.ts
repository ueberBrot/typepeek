import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import {
  comparePublicInterfaces,
  inspectExport,
  inspectInterfaceOverview,
} from "#typepeek/inspection";

import { match } from "./helpers/matchers.ts";
import { PACKAGE_MANAGER_PINS } from "./helpers/package-toolchain.ts";
import type { WorkspacePackageMatrix } from "./helpers/workspace-package-matrix.ts";
import { materializeWorkspacePackageMatrix } from "./helpers/workspace-package-matrix.ts";

let matrix: WorkspacePackageMatrix;

describe("workspace Resolution Contexts", () => {
  beforeAll(async () => {
    matrix = await materializeWorkspacePackageMatrix();
  }, 120_000);

  afterAll(async () => {
    await matrix?.cleanup();
  });

  it("uses genuine workspace links from every supported package manager", () => {
    expect(
      matrix.installations.map(
        ({ manager, sourceWorkspaceIsLink, version }) => ({
          manager,
          sourceWorkspaceIsLink,
          version,
        })
      )
    ).toStrictEqual(
      PACKAGE_MANAGER_PINS.map(({ manager, version }) => ({
        manager,
        sourceWorkspaceIsLink: true,
        version,
      }))
    );
  });

  it("selects the package version visible from each nested Resolution Context", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext, consumerTwoContext }) => {
        const [consumerOne, consumerTwo] = await Promise.all([
          inspectExport({
            exportName: "contextValue",
            resolutionContext: consumerOneContext,
            specifier: "@typepeek-fixture/contextual",
          }),
          inspectExport({
            exportName: "contextValue",
            resolutionContext: consumerTwoContext,
            specifier: "@typepeek-fixture/contextual",
          }),
        ]);

        expect([
          { consumerOne, consumerTwo },
          JSON.stringify(consumerOne).includes("context-one"),
          JSON.stringify(consumerOne).includes("context-two"),
          JSON.stringify(consumerTwo).includes("context-two"),
          JSON.stringify(consumerTwo).includes("context-one"),
        ]).toStrictEqual([
          match.objectContaining({
            consumerOne: match.objectContaining({
              result: match.objectContaining({
                packageIdentity: match.objectContaining({ version: "1.0.0" }),
              }),
              status: "success",
            }),
            consumerTwo: match.objectContaining({
              result: match.objectContaining({
                packageIdentity: match.objectContaining({ version: "2.0.0" }),
              }),
              status: "success",
            }),
          }),
          true,
          false,
          true,
          false,
        ]);
      }
    );
  }, 30_000);

  it("keeps installed versions distinct when their overview indexes have the same names", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext, consumerTwoContext }) => {
        const outcome = await comparePublicInterfaces({
          after: {
            resolutionContext: consumerTwoContext,
            specifier: "@typepeek-fixture/contextual",
          },
          before: {
            resolutionContext: consumerOneContext,
            specifier: "@typepeek-fixture/contextual",
          },
        });

        expect(outcome).toMatchObject({
          result: {
            after: { packageIdentity: { version: "2.0.0" } },
            before: { packageIdentity: { version: "1.0.0" } },
            moduleExports: { added: [], removed: [] },
            scope: "interface-overview",
          },
          status: "success",
        });
      }
    );
  }, 30_000);

  it("inspects only workspace Package Modules resolvable from the selected Resolution Context", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({
        consumerOneContext,
        hiddenWorkspaceInstalledElsewhere,
        hiddenWorkspacePackage,
        hiddenWorkspaceResolvableFromConsumerOne,
      }) => {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: consumerOneContext,
          specifier: hiddenWorkspacePackage,
        });

        const expected = hiddenWorkspaceResolvableFromConsumerOne
          ? match.objectContaining({
              result: match.objectContaining({
                moduleExports: [
                  match.objectContaining({ name: "hiddenWorkspaceValue" }),
                ],
                packageIdentity: {
                  name: hiddenWorkspacePackage,
                  version: "1.0.0",
                },
              }),
              status: "success",
            })
          : {
              message: `Specifier "${hiddenWorkspacePackage}" is not installed from this Resolution Context.`,
              reason: "specifier-not-found",
              status: "not-found",
            };

        expect([hiddenWorkspaceInstalledElsewhere, outcome]).toStrictEqual([
          true,
          expected,
        ]);
      }
    );
  });

  it("does not turn TypeScript path aliases into Package Modules", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext }) => {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: consumerOneContext,
          specifier: "project-source-alias",
        });

        expect(outcome).toStrictEqual({
          message:
            'Specifier "project-source-alias" is not installed from this Resolution Context.',
          reason: "specifier-not-found",
          status: "not-found",
        });
      }
    );
  });

  it("projects source declarations for all package managers", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext, sourceWorkspacePackage }) => {
        const [overview, focused] = await Promise.all([
          inspectInterfaceOverview({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "createWorkspaceThing",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
        ]);

        expect([
          { focused, overview },
          JSON.stringify({ focused, overview }).includes("version"),
          JSON.stringify(focused).includes("implementationSecret"),
          JSON.stringify(focused).includes("return `"),
        ]).toStrictEqual([
          match.objectContaining({
            focused: match.objectContaining({
              result: match.objectContaining({
                moduleExport: match.objectContaining({
                  name: "createWorkspaceThing",
                }),
                packageIdentity: match.objectContaining({
                  name: sourceWorkspacePackage,
                }),
              }),
              status: "success",
            }),
            overview: match.objectContaining({
              result: match.objectContaining({
                moduleExports: [
                  match.objectContaining({ name: "MixedOverloads" }),
                  match.objectContaining({ name: "WorkspaceOptions" }),
                  match.objectContaining({ name: "WorkspaceOverloadTools" }),
                  match.objectContaining({ name: "WorkspaceSource" }),
                  match.objectContaining({ name: "WorkspaceTools" }),
                  match.objectContaining({
                    name: "aliasedDestructuredWorkspaceValue",
                  }),
                  match.objectContaining({ name: "boxedWorkspaceShape" }),
                  match.objectContaining({ name: "createWorkspaceThing" }),
                  match.objectContaining({
                    name: "destructuredWorkspaceValue",
                  }),
                  match.objectContaining({ name: "inferredCarrier" }),
                  match.objectContaining({ name: "inferredWorkspaceShape" }),
                  match.objectContaining({ name: "inferredWorkspaceValue" }),
                  match.objectContaining({ name: "loadWorkspaceArrow" }),
                  match.objectContaining({ name: "loadWorkspaceValue" }),
                  match.objectContaining({ name: "makeLocalWorkspaceValue" }),
                  match.objectContaining({ name: "makeWorkspaceShape" }),
                  match.objectContaining({ name: "nestedWorkspaceLoader" }),
                  match.objectContaining({ name: "overloadedWorkspaceValue" }),
                  match.objectContaining({ name: "publicWorkspaceNumber" }),
                  match.objectContaining({ name: "workspaceValues" }),
                ],
                packageIdentity: match.objectContaining({
                  name: sourceWorkspacePackage,
                }),
              }),
              status: "success",
            }),
          }),
          false,
          false,
          false,
        ]);

        const [inferred, namespace, classExport] = await Promise.all([
          inspectExport({
            exportName: "inferredWorkspaceValue",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "WorkspaceTools",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "WorkspaceSource",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
        ]);

        expect({ classExport, inferred, namespace }).toMatchObject({
          classExport: { status: "success" },
          inferred: { status: "success" },
          namespace: { status: "success" },
        });

        const sourceDeclarations = JSON.stringify({
          classExport,
          inferred,
          namespace,
        });

        expect([
          sourceDeclarations.includes('mode: \\"source\\"'),
          sourceDeclarations.includes("createLabel(): string"),
          sourceDeclarations.includes("implementationSecret"),
          sourceDeclarations.includes("return "),
          sourceDeclarations.includes("static {"),
          sourceDeclarations.includes("secret"),
        ]).toStrictEqual([true, true, false, false, false, false]);
      }
    );
  });

  it("retains inferred dependencies and namespace overloads for all package managers", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext, sourceWorkspacePackage }) => {
        const [
          inferredInterfaceOutcome,
          factoryOutcome,
          overloaded,
          namespaceOverload,
        ] = await Promise.all([
          inspectExport({
            exportName: "inferredWorkspaceShape",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "makeWorkspaceShape",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "overloadedWorkspaceValue",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "WorkspaceOverloadTools",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
        ]);

        expect([
          { factoryOutcome, inferredInterfaceOutcome, overloaded },
          requireDefined(
            JSON.stringify(overloaded).match(
              /function overloadedWorkspaceValue/gu
            )
          ).length,
        ]).toStrictEqual([
          match.objectContaining({
            factoryOutcome: match.objectContaining({
              result: match.objectContaining({
                supportingTypes: [
                  match.objectContaining({ name: "WorkspaceShape" }),
                ],
              }),
              status: "success",
            }),
            inferredInterfaceOutcome: match.objectContaining({
              result: match.objectContaining({
                supportingTypes: [
                  match.objectContaining({ name: "WorkspaceShape" }),
                ],
              }),
              status: "success",
            }),
            overloaded: match.objectContaining({ status: "success" }),
          }),
          2,
        ]);
        const namespaceOverloadEvidence = JSON.stringify(namespaceOverload);
        expect([
          namespaceOverloadEvidence.includes(
            "function run(value: string): string"
          ),
          namespaceOverloadEvidence.includes("function unrelated(): number"),
          namespaceOverloadEvidence.includes("run(value: string | number)"),
        ]).toStrictEqual([true, true, false]);
      }
    );
  });

  it("handles boxed values and async overloads for all package managers", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext, sourceWorkspacePackage }) => {
        const [mixedOverloads, asyncExport] = await Promise.all([
          inspectExport({
            exportName: "MixedOverloads",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "loadWorkspaceValue",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
        ]);

        const mixedOverloadEvidence = JSON.stringify(mixedOverloads);
        expect([
          mixedOverloadEvidence.includes("static run(value: string): string"),
          mixedOverloadEvidence.includes("run(): number"),
          mixedOverloadEvidence.includes("static run(value: string | number)"),
          asyncExport,
        ]).toStrictEqual([
          true,
          true,
          false,
          {
            message:
              "An inferred async Public Interface cannot be represented statically.",
            reason: "unsupported-evidence",
            status: "unsupported",
          },
        ]);

        const [boxed, implementationLocal, asyncArrow] = await Promise.all([
          inspectExport({
            exportName: "boxedWorkspaceShape",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "publicWorkspaceNumber",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "loadWorkspaceArrow",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
        ]);

        expect([boxed, implementationLocal, asyncArrow]).toStrictEqual([
          match.objectContaining({
            result: match.objectContaining({
              supportingTypes: [
                match.objectContaining({ name: "Box" }),
                match.objectContaining({ name: "WorkspaceShape" }),
              ],
            }),
            status: "success",
          }),
          match.objectContaining({
            result: match.objectContaining({ supportingTypes: [] }),
            status: "success",
          }),
          {
            message:
              "An inferred async Public Interface cannot be represented statically.",
            reason: "unsupported-evidence",
            status: "unsupported",
          },
        ]);
      }
    );
  });

  it("projects inherited and destructured values for all package managers", async () => {
    await Array.fromAsync(
      matrix.installations,
      async ({ consumerOneContext, sourceWorkspacePackage }) => {
        const [
          carrier,
          values,
          nestedAsync,
          destructured,
          aliasedDestructured,
          localReturn,
        ] = await Promise.all([
          inspectExport({
            exportName: "inferredCarrier",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "workspaceValues",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "nestedWorkspaceLoader",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "destructuredWorkspaceValue",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "aliasedDestructuredWorkspaceValue",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
          inspectExport({
            exportName: "makeLocalWorkspaceValue",
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
          }),
        ]);

        expect([
          carrier,
          JSON.stringify(carrier).includes("HiddenMemberShape"),
          values,
          nestedAsync,
          destructured,
          aliasedDestructured,
          localReturn,
        ]).toStrictEqual([
          match.objectContaining({
            result: match.objectContaining({
              supportingTypes: [
                match.objectContaining({ name: "PublicCarrier" }),
              ],
            }),
            status: "success",
          }),
          false,
          match.objectContaining({
            result: match.objectContaining({
              moduleExport: match.objectContaining({
                spaces: [
                  match.objectContaining({
                    declarations: [
                      match.objectContaining({
                        text: "workspaceValues: number[]",
                      }),
                    ],
                    space: "value",
                  }),
                ],
              }),
            }),
            status: "success",
          }),
          {
            message:
              "An inferred async Public Interface cannot be represented statically.",
            reason: "unsupported-evidence",
            status: "unsupported",
          },
          {
            message:
              "The selected Module Export contains an unsupported declaration kind.",
            reason: "unsupported-evidence",
            status: "unsupported",
          },
          {
            message:
              "The selected Module Export contains an unsupported declaration kind.",
            reason: "unsupported-evidence",
            status: "unsupported",
          },
          {
            message:
              "An inferred Public Interface references an implementation-local type.",
            reason: "unsupported-evidence",
            status: "unsupported",
          },
        ]);
      }
    );
  });
});
