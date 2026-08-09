import { access } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";

import {
  type PackageManagerMatrix,
  PACKAGE_MANAGER_PINS,
  materializePackageManagerMatrix,
} from "./helpers/index.ts";

describe("Supported Installation package-manager layouts", () => {
  let matrix: PackageManagerMatrix;

  beforeAll(async () => {
    matrix = await materializePackageManagerMatrix();
  }, 120_000);

  afterAll(async () => {
    await matrix?.cleanup();
  });

  it("uses the pinned npm, pnpm, and Bun installers", () => {
    expect(matrix.installations.map(({ manager, version }) => ({ manager, version }))).toEqual(
      PACKAGE_MANAGER_PINS.map(({ manager, version }) => ({ manager, version })),
    );
  });

  it("materializes hoisted and isolated-store symlink layouts", () => {
    expect(
      matrix.installations.map(({ manager, subjectIsSymlink, subjectPhysicalPath }) => ({
        manager,
        subjectIsSymlink,
        usesIsolatedStore: subjectPhysicalPath.includes(".pnpm"),
      })),
    ).toEqual([
      { manager: "npm", subjectIsSymlink: false, usesIsolatedStore: false },
      { manager: "pnpm", subjectIsSymlink: true, usesIsolatedStore: true },
      { manager: "bun", subjectIsSymlink: false, usesIsolatedStore: false },
    ]);
  });

  it("finds equivalent scoped Package Module Public Interfaces through every layout", async () => {
    const publicInterfaces = await Promise.all(
      matrix.installations.map(async ({ resolutionContext }) => {
        const overview = await inspectInterfaceOverview({
          resolutionContext,
          specifier: "@typepeek-fixture/layout-subject",
        });
        const focused = await Promise.all(
          ["nestedValue", "subjectValue"].map((exportName) =>
            inspectExport({
              resolutionContext,
              specifier: "@typepeek-fixture/layout-subject",
              exportName,
            }),
          ),
        );

        expect(overview.status).toBe("success");
        expect(focused.map(({ status }) => status)).toEqual(["success", "success"]);
        if (overview.status !== "success" || focused.some(({ status }) => status !== "success")) {
          return undefined;
        }

        return {
          overview: overview.result,
          focused: focused.map((outcome) =>
            outcome.status === "success" ? withoutDeclarationPaths(outcome.result) : undefined,
          ),
        };
      }),
    );

    expect(publicInterfaces.slice(1)).toEqual([publicInterfaces[0], publicInterfaces[0]]);
    expect(publicInterfaces[0]).toMatchObject({
      overview: {
        packageIdentity: { name: "@typepeek-fixture/layout-subject", version: "1.0.0" },
        moduleExports: [{ name: "nestedValue" }, { name: "subjectValue" }],
      },
      focused: [
        {
          moduleExport: {
            name: "nestedValue",
            spaces: [
              {
                space: "value",
                declarations: [
                  {
                    provenance: {
                      packageIdentity: {
                        name: "@typepeek-fixture/nested",
                        version: "1.0.0",
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        { moduleExport: { name: "subjectValue" } },
      ],
    });
    expect(JSON.stringify(publicInterfaces[0])).toContain("nested-v1");
    expect(JSON.stringify(publicInterfaces[0])).not.toContain("nested-v2");
  });

  it("keeps package-manager activity in setup and never executes package scripts", async () => {
    await Promise.all(
      matrix.installations.map(({ installSentinel }) =>
        expect(access(installSentinel)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
  });

  it("inspects Installed Evidence with process and network access denied", async () => {
    for (const { resolutionContext } of matrix.installations) {
      const inspection = await matrix.staticInspection.run({
        adapter: { kind: "source-checkout", sourceCheckout: process.cwd() },
        arguments_: ["@typepeek-fixture/layout-subject"],
        diagnosticContext: `source CLI in Resolution Context ${resolutionContext}`,
        resolutionContext,
      });

      expect(inspection.stdout).toContain("Interface Overview");
    }
    await matrix.staticInspection.verifyNoIo();
  });

  it("reports an unsupported non-node_modules installation without loading it", async () => {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: matrix.unsupportedInstallation.resolutionContext,
      specifier: "@typepeek-fixture/layout-subject",
    });

    expect(outcome).toEqual({
      status: "unsupported",
      message: "The Resolution Context uses an unsupported installation without node_modules.",
    });
    await expect(access(matrix.unsupportedInstallation.runtimeSentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

// File paths vary by layout; all other provenance must match.
function withoutDeclarationPaths(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutDeclarationPaths);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if ("packageIdentity" in value && "file" in value && "line" in value && "column" in value) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        key === "file" ? [] : [[key, withoutDeclarationPaths(child)]],
      ),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, withoutDeclarationPaths(child)]),
  );
}
