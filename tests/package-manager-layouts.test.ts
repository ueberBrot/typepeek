import { access } from "node:fs/promises";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";
import type { JsonInput } from "#typepeek/shared/json-data";
import {
  decodeJson,
  isJsonInputArray,
  isJsonInputObject,
} from "#typepeek/shared/json-data";

import { match } from "./helpers/matchers.ts";
import type { PackageManagerMatrix } from "./helpers/package-manager-matrix.ts";
import { materializePackageManagerMatrix } from "./helpers/package-manager-matrix.ts";
import { PACKAGE_MANAGER_PINS } from "./helpers/package-toolchain.ts";

// File paths vary by layout; all other provenance must match.
const withoutDeclarationPaths = function withoutDeclarationPaths(
  value: JsonInput
): JsonInput {
  if (isJsonInputArray(value)) {
    return value.map(withoutDeclarationPaths);
  }

  if (!isJsonInputObject(value)) {
    return value;
  }

  if (
    "packageIdentity" in value &&
    "file" in value &&
    "line" in value &&
    "column" in value
  ) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        key === "file" ? [] : [[key, withoutDeclarationPaths(child)]]
      )
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      withoutDeclarationPaths(child),
    ])
  );
};

describe("package-manager-layouts", () => {
  describe("Supported Installation package-manager layouts", () => {
    let matrix: PackageManagerMatrix;
    beforeAll(async () => {
      matrix = await materializePackageManagerMatrix();
    }, 120_000);

    afterAll(async () => {
      await matrix?.cleanup();
    });

    it("uses the pinned npm, pnpm, and Bun installers", () => {
      expect(
        matrix.installations.map(({ manager, version }) => ({
          manager,
          version,
        }))
      ).toStrictEqual(
        PACKAGE_MANAGER_PINS.map(({ manager, version }) => ({
          manager,
          version,
        }))
      );
    });

    it("materializes hoisted and isolated-store symlink layouts", () => {
      expect(
        matrix.installations.map(
          ({ manager, subjectIsSymlink, subjectPhysicalPath }) => ({
            manager,
            subjectIsSymlink,
            usesIsolatedStore: subjectPhysicalPath.includes(".pnpm"),
          })
        )
      ).toStrictEqual([
        { manager: "npm", subjectIsSymlink: false, usesIsolatedStore: false },
        { manager: "pnpm", subjectIsSymlink: true, usesIsolatedStore: true },
        { manager: "bun", subjectIsSymlink: false, usesIsolatedStore: false },
      ]);
    });

    it("finds equivalent scoped Package Module Public Interfaces through every layout", async () => {
      const publicInterfaces = await Promise.all(
        matrix.installations.map(async ({ manager, resolutionContext }) => {
          const overview = await inspectInterfaceOverview({
            resolutionContext,
            specifier: "@typepeek-fixture/layout-subject",
          });

          const focused = await Promise.all(
            ["nestedValue", "subjectValue"].map(
              async (exportName) =>
                await inspectExport({
                  exportName,
                  resolutionContext,
                  specifier: "@typepeek-fixture/layout-subject",
                })
            )
          );

          expect({ focused, manager, overview }).toMatchObject({
            focused: [{ status: "success" }, { status: "success" }],
            manager,
            overview: { status: "success" },
          });

          if (
            overview.status !== "success" ||
            focused.some(({ status }) => status !== "success")
          ) {
            throw new Error(
              "Every package-manager layout inspection must succeed."
            );
          }

          return {
            focused: focused.map((outcome) =>
              outcome.status === "success"
                ? withoutDeclarationPaths(
                    decodeJson(Schema.Json, JSON.stringify(outcome.result))
                  )
                : undefined
            ),
            overview: overview.result,
          };
        })
      );

      expect([
        publicInterfaces.slice(1),
        publicInterfaces[0],
        JSON.stringify(publicInterfaces[0]).includes("subject-nested"),
        JSON.stringify(publicInterfaces[0]).includes("repository-nested"),
      ]).toStrictEqual([
        [publicInterfaces[0], publicInterfaces[0]],
        match.objectContaining({
          focused: [
            match.objectContaining({
              moduleExport: match.objectContaining({
                name: "nestedValue",
                spaces: [
                  match.objectContaining({
                    declarations: [
                      match.objectContaining({
                        provenance: match.objectContaining({
                          packageIdentity: match.objectContaining({
                            name: "@typepeek-fixture/nested",
                            version: "1.0.0",
                          }),
                        }),
                      }),
                    ],
                    space: "value",
                  }),
                ],
              }),
            }),
            match.objectContaining({
              moduleExport: match.objectContaining({ name: "subjectValue" }),
            }),
          ],
          overview: match.objectContaining({
            moduleExports: [
              match.objectContaining({ name: "nestedValue" }),
              match.objectContaining({ name: "subjectValue" }),
            ],
            packageIdentity: match.objectContaining({
              name: "@typepeek-fixture/layout-subject",
              version: "1.0.0",
            }),
          }),
        }),
        true,
        false,
      ]);
    }, 30_000);

    it("keeps package-manager activity in setup and never executes package scripts", async () => {
      await Promise.all(
        matrix.installations.map(async ({ installSentinel }) => {
          await expect(access(installSentinel)).rejects.toMatchObject({
            code: "ENOENT",
          });
        })
      );
    });

    it("inspects Installed Evidence with process and network access denied", async () => {
      await Array.fromAsync(
        matrix.installations,
        async ({ resolutionContext }) => {
          const inspection = await matrix.staticInspection.run({
            adapter: { kind: "source-checkout", sourceCheckout: process.cwd() },
            cliArguments: ["@typepeek-fixture/layout-subject"],
            diagnosticContext: `source CLI in Resolution Context ${resolutionContext}`,
            resolutionContext,
          });

          expect(inspection.stdout).toContain("Interface Overview");
        }
      );

      await matrix.staticInspection.verifyNoIo();
    }, 30_000);

    it("reports an unsupported non-node_modules installation without loading it", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: matrix.unsupportedInstallation.resolutionContext,
        specifier: "@typepeek-fixture/layout-subject",
      });

      expect(outcome).toStrictEqual({
        message:
          "The Resolution Context uses an unsupported installation without node_modules.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
      await expect(
        access(matrix.unsupportedInstallation.runtimeSentinel)
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("stops an undeclared Specifier at an unsupported installation", async () => {
      const { ancestorPackageSpecifier, resolutionContext, runtimeSentinel } =
        matrix.unsupportedInstallation;

      const outcome = await inspectInterfaceOverview({
        resolutionContext,
        specifier: ancestorPackageSpecifier,
      });

      expect(outcome).toStrictEqual({
        message: `Specifier "${ancestorPackageSpecifier}" is not installed from this Resolution Context.`,
        reason: "specifier-not-found",
        status: "not-found",
      });
      await expect(access(runtimeSentinel)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
