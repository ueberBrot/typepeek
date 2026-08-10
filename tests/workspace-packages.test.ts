import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";

import {
  type WorkspacePackageMatrix,
  materializeWorkspacePackageMatrix,
  PACKAGE_MANAGER_PINS,
} from "./helpers/index.ts";

describe("workspace Resolution Contexts", () => {
  let matrix: WorkspacePackageMatrix;

  beforeAll(async () => {
    matrix = await materializeWorkspacePackageMatrix();
  }, 120_000);

  afterAll(async () => {
    await matrix?.cleanup();
  });

  it("uses genuine workspace links from every supported package manager", () => {
    expect(
      matrix.installations.map(({ manager, sourceWorkspaceIsLink, version }) => ({
        manager,
        sourceWorkspaceIsLink,
        version,
      })),
    ).toEqual(
      PACKAGE_MANAGER_PINS.map(({ manager, version }) => ({
        manager,
        sourceWorkspaceIsLink: true,
        version,
      })),
    );
  });

  it("selects the package version visible from each nested Resolution Context", async () => {
    for (const { consumerOneContext, consumerTwoContext, manager } of matrix.installations) {
      const [consumerOne, consumerTwo] = await Promise.all([
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: "@typepeek-fixture/contextual",
          exportName: "contextValue",
        }),
        inspectExport({
          resolutionContext: consumerTwoContext,
          specifier: "@typepeek-fixture/contextual",
          exportName: "contextValue",
        }),
      ]);

      expect({ consumerOne, consumerTwo }, manager).toMatchObject({
        consumerOne: {
          status: "success",
          result: { packageIdentity: { version: "1.0.0" } },
        },
        consumerTwo: {
          status: "success",
          result: { packageIdentity: { version: "2.0.0" } },
        },
      });
      expect(JSON.stringify(consumerOne)).toContain("context-one");
      expect(JSON.stringify(consumerOne)).not.toContain("context-two");
      expect(JSON.stringify(consumerTwo)).toContain("context-two");
      expect(JSON.stringify(consumerTwo)).not.toContain("context-one");
    }
  }, 30_000);

  it("rejects a workspace package not declared by the selected Resolution Context", async () => {
    for (const {
      consumerOneContext,
      hiddenWorkspaceInstalledElsewhere,
      hiddenWorkspacePackage,
      manager,
    } of matrix.installations) {
      expect(hiddenWorkspaceInstalledElsewhere, manager).toBe(true);
      const outcome = await inspectInterfaceOverview({
        resolutionContext: consumerOneContext,
        specifier: hiddenWorkspacePackage,
      });

      expect(outcome, manager).toEqual({
        status: "not-found",
        message: `Specifier "${hiddenWorkspacePackage}" is not installed from this Resolution Context.`,
      });
    }
  });

  it("does not turn TypeScript path aliases into Package Modules", async () => {
    for (const { consumerOneContext, manager } of matrix.installations) {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: consumerOneContext,
        specifier: "project-source-alias",
      });

      expect(outcome, manager).toEqual({
        status: "not-found",
        message: 'Specifier "project-source-alias" is not installed from this Resolution Context.',
      });
    }
  });

  it("inspects unversioned package-exposed TypeScript source without implementation bodies", async () => {
    for (const { consumerOneContext, manager, sourceWorkspacePackage } of matrix.installations) {
      const [overview, focused] = await Promise.all([
        inspectInterfaceOverview({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "createWorkspaceThing",
        }),
      ]);

      expect({ focused, overview }, manager).toMatchObject({
        overview: {
          status: "success",
          result: {
            packageIdentity: { name: sourceWorkspacePackage },
            moduleExports: [
              { name: "MixedOverloads" },
              { name: "WorkspaceOptions" },
              { name: "WorkspaceOverloadTools" },
              { name: "WorkspaceSource" },
              { name: "WorkspaceTools" },
              { name: "aliasedDestructuredWorkspaceValue" },
              { name: "boxedWorkspaceShape" },
              { name: "createWorkspaceThing" },
              { name: "destructuredWorkspaceValue" },
              { name: "inferredCarrier" },
              { name: "inferredWorkspaceShape" },
              { name: "inferredWorkspaceValue" },
              { name: "loadWorkspaceArrow" },
              { name: "loadWorkspaceValue" },
              { name: "makeLocalWorkspaceValue" },
              { name: "makeWorkspaceShape" },
              { name: "nestedWorkspaceLoader" },
              { name: "overloadedWorkspaceValue" },
              { name: "publicWorkspaceNumber" },
              { name: "workspaceValues" },
            ],
          },
        },
        focused: {
          status: "success",
          result: {
            packageIdentity: { name: sourceWorkspacePackage },
            moduleExport: { name: "createWorkspaceThing" },
          },
        },
      });
      expect(JSON.stringify({ focused, overview })).not.toContain("version");
      expect(JSON.stringify(focused)).not.toContain("implementationSecret");
      expect(JSON.stringify(focused)).not.toContain("return `");

      const [inferred, namespace, classExport] = await Promise.all([
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "inferredWorkspaceValue",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "WorkspaceTools",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "WorkspaceSource",
        }),
      ]);
      expect({ classExport, inferred, namespace }, manager).toMatchObject({
        classExport: { status: "success" },
        inferred: { status: "success" },
        namespace: { status: "success" },
      });
      const sourceDeclarations = JSON.stringify({ classExport, inferred, namespace });
      expect(sourceDeclarations).toContain('mode: \\"source\\"');
      expect(sourceDeclarations).toContain("createLabel(): string");
      expect(sourceDeclarations).not.toContain("implementationSecret");
      expect(sourceDeclarations).not.toContain("return ");
      expect(sourceDeclarations).not.toContain("static {");
      expect(sourceDeclarations).not.toContain("secret");

      const [
        inferredShape,
        shapeFactory,
        overloaded,
        namespaceOverload,
        mixedOverloads,
        asyncExport,
      ] = await Promise.all([
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "inferredWorkspaceShape",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "makeWorkspaceShape",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "overloadedWorkspaceValue",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "WorkspaceOverloadTools",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "MixedOverloads",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "loadWorkspaceValue",
        }),
      ]);
      expect({ inferredShape, overloaded, shapeFactory }, manager).toMatchObject({
        inferredShape: {
          status: "success",
          result: { supportingTypes: [{ name: "WorkspaceShape" }] },
        },
        overloaded: { status: "success" },
        shapeFactory: {
          status: "success",
          result: { supportingTypes: [{ name: "WorkspaceShape" }] },
        },
      });
      expect(JSON.stringify(overloaded).match(/function overloadedWorkspaceValue/g)).toHaveLength(
        2,
      );
      const namespaceOverloadEvidence = JSON.stringify(namespaceOverload);
      expect(namespaceOverloadEvidence).toContain("function run(value: string): string");
      expect(namespaceOverloadEvidence).toContain("function unrelated(): number");
      expect(namespaceOverloadEvidence).not.toContain("run(value: string | number)");
      const mixedOverloadEvidence = JSON.stringify(mixedOverloads);
      expect(mixedOverloadEvidence).toContain("static run(value: string): string");
      expect(mixedOverloadEvidence).toContain("run(): number");
      expect(mixedOverloadEvidence).not.toContain("static run(value: string | number)");
      expect(asyncExport).toEqual({
        status: "unsupported",
        message: "An inferred async Public Interface cannot be represented statically.",
      });

      const [boxed, implementationLocal, asyncArrow] = await Promise.all([
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "boxedWorkspaceShape",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "publicWorkspaceNumber",
        }),
        inspectExport({
          resolutionContext: consumerOneContext,
          specifier: sourceWorkspacePackage,
          exportName: "loadWorkspaceArrow",
        }),
      ]);
      expect(boxed).toMatchObject({
        status: "success",
        result: {
          supportingTypes: [{ name: "Box" }, { name: "WorkspaceShape" }],
        },
      });
      expect(implementationLocal).toMatchObject({
        status: "success",
        result: { supportingTypes: [] },
      });
      expect(asyncArrow).toEqual({
        status: "unsupported",
        message: "An inferred async Public Interface cannot be represented statically.",
      });

      const [carrier, values, nestedAsync, destructured, aliasedDestructured, localReturn] =
        await Promise.all([
          inspectExport({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
            exportName: "inferredCarrier",
          }),
          inspectExport({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
            exportName: "workspaceValues",
          }),
          inspectExport({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
            exportName: "nestedWorkspaceLoader",
          }),
          inspectExport({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
            exportName: "destructuredWorkspaceValue",
          }),
          inspectExport({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
            exportName: "aliasedDestructuredWorkspaceValue",
          }),
          inspectExport({
            resolutionContext: consumerOneContext,
            specifier: sourceWorkspacePackage,
            exportName: "makeLocalWorkspaceValue",
          }),
        ]);
      expect(carrier).toMatchObject({
        status: "success",
        result: { supportingTypes: [{ name: "PublicCarrier" }] },
      });
      expect(JSON.stringify(carrier)).not.toContain("HiddenMemberShape");
      expect(values).toEqual({
        status: "unsupported",
        message:
          "An inferred Public Interface type cannot be represented statically without standard libraries.",
      });
      expect(nestedAsync).toEqual({
        status: "unsupported",
        message: "An inferred async Public Interface cannot be represented statically.",
      });
      expect(destructured).toEqual({
        status: "unsupported",
        message: "The selected Module Export contains an unsupported declaration kind.",
      });
      expect(aliasedDestructured).toEqual({
        status: "unsupported",
        message: "The selected Module Export contains an unsupported declaration kind.",
      });
      expect(localReturn).toEqual({
        status: "unsupported",
        message: "An inferred Public Interface references an implementation-local type.",
      });
    }
  }, 30_000);
});
