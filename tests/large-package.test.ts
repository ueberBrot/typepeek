import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { InspectionCoreInvocationReceipt } from "#typepeek/inspection/core";
import { invokeInspectionCore } from "#typepeek/inspection/core";

import { match } from "./helpers/matchers.ts";

let resolutionContext: string;
const specifier = "large-declaration-package";

describe("large-package", () => {
  beforeAll(async () => {
    resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-large-declarations-")
    );

    const packageRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      specifier
    );

    const dependencyRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      "shared-types"
    );

    const selfRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      "self-referencing-package"
    );

    await mkdir(nodePath.join(packageRoot, "declarations"), {
      recursive: true,
    });
    await mkdir(dependencyRoot, { recursive: true });
    await mkdir(selfRoot, { recursive: true });
    await Promise.all([
      writeFile(
        nodePath.join(resolutionContext, "package.json"),
        JSON.stringify({
          dependencies: {
            "self-referencing-package": "1.0.0",
            [specifier]: "1.0.0",
          },
          name: "consumer",
        })
      ),
      writeFile(
        nodePath.join(packageRoot, "package.json"),
        JSON.stringify({
          dependencies: { "shared-types": "1.0.0" },
          name: specifier,
          types: "index.d.ts",
          version: "1.0.0",
        })
      ),
      writeFile(
        nodePath.join(dependencyRoot, "package.json"),
        JSON.stringify({
          name: "shared-types",
          types: "index.d.ts",
          version: "1.0.0",
        })
      ),
      writeFile(
        nodePath.join(dependencyRoot, "index.d.ts"),
        "export interface Input { value: string; }"
      ),
      writeFile(
        nodePath.join(selfRoot, "package.json"),
        JSON.stringify({
          exports: { ".": "./index.d.ts", "./input": "./input.d.ts" },
          name: "self-referencing-package",
          version: "1.0.0",
        })
      ),
      writeFile(
        nodePath.join(selfRoot, "index.d.ts"),
        'import type { Input } from "self-referencing-package/input"; export declare function inspect(value: Input): string;'
      ),
      writeFile(
        nodePath.join(selfRoot, "input.d.ts"),
        "export interface Input { value: string; }"
      ),
      ...Array.from({ length: 600 }, async (_, index) => {
        await writeFile(
          nodePath.join(packageRoot, "declarations", `entry-${index}.d.ts`),
          `import type { Input } from "shared-types";
         export declare function entry${index}(input: Input): string;`
        );
      }),
      writeFile(
        nodePath.join(packageRoot, "index.d.ts"),
        Array.from(
          { length: 600 },
          (_, index) =>
            `export { entry${index} } from "./declarations/entry-${index}.js";`
        ).join("\n")
      ),
    ]);
  });

  afterAll(async () => {
    if (resolutionContext !== undefined) {
      await rm(resolutionContext, { force: true, recursive: true });
    }
  });

  it("resolves a package's own Public Subpath without a dependency on itself", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("signature-inspection", {
        exportName: "inspect",
        resolutionContext,
        specifier: "self-referencing-package",
      })
    );

    expect(outcome).toMatchObject({
      result: {
        moduleExport: { signatures: [{ text: "(value: Input): string" }] },
      },
      status: "success",
    });
  });

  it("inspects one export in a large declaration graph with shared dependencies", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("signature-inspection", {
        exportName: "entry599",
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        moduleExport: {
          name: "entry599",
          signatures: [{ kind: "call", text: "(input: Input): string" }],
        },
      },
      status: "success",
    });
  });

  it("pages a large Module Export index without gaps or duplicate names", async () => {
    const names: string[] = [];
    let cursor: string | undefined = "start";

    // Each page supplies the cursor needed to request the next one.
    while (cursor !== undefined) {
      const { outcome }: InspectionCoreInvocationReceipt<"interface-overview"> =
        // oxlint-disable-next-line eslint/no-await-in-loop -- Pagination requests depend on the previous response.
        await Effect.runPromise(
          invokeInspectionCore("interface-overview", {
            cursor,
            resolutionContext,
            specifier,
          })
        );

      expect(outcome).toMatchObject({
        result: {
          exportPage: { complete: false, cursor, totalModuleExports: 600 },
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        return;
      }

      expect(outcome.result.moduleExports).toHaveLength(100);
      names.push(...outcome.result.moduleExports.map(({ name }) => name));
      cursor = outcome.result.exportPage?.nextCursor;
    }

    expect([
      names.length,
      new Set(names).size,
      names.includes("entry599"),
    ]).toStrictEqual([600, 600, true]);
  }, 90_000);

  it("rejects continuation from another Resolution Variant", async () => {
    const { outcome: first } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", {
        accessStyle: "import",
        cursor: "start",
        resolutionContext,
        specifier,
      })
    );

    expect(first.status).toBe("success");

    if (first.status !== "success") {
      return;
    }

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", {
        accessStyle: "require",
        cursor: first.result.exportPage?.nextCursor,
        resolutionContext,
        specifier,
      })
    );

    expect(outcome).toMatchObject({
      reason: "invalid-request",
      status: "unsupported",
    });
  });

  it("rejects an export cursor after the index changes", async () => {
    const indexPath = nodePath.join(
      resolutionContext,
      "node_modules",
      specifier,
      "index.d.ts"
    );

    const original = await readFile(indexPath, "utf-8");

    const { outcome: first } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", {
        cursor: "start",
        resolutionContext,
        specifier,
      })
    );

    expect(first.status).toBe("success");

    if (first.status !== "success") {
      return;
    }

    try {
      await writeFile(
        indexPath,
        `${original}\nexport declare const added: string;`
      );

      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("interface-overview", {
          cursor: first.result.exportPage?.nextCursor,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        reason: "invalid-request",
        status: "unsupported",
      });

      const { outcome: restarted } = await Effect.runPromise(
        invokeInspectionCore("interface-overview", {
          cursor: "start",
          resolutionContext,
          specifier,
        })
      );

      expect(restarted).toMatchObject({
        result: {
          exportPage: { totalModuleExports: 601 },
          moduleExports: match.arrayContaining([{ name: "added" }]),
        },
        status: "success",
      });
    } finally {
      await writeFile(indexPath, original);
    }
  });

  it("does not present an unresolved re-export graph as an export page", async () => {
    const indexPath = nodePath.join(
      resolutionContext,
      "node_modules",
      specifier,
      "index.d.ts"
    );

    const original = await readFile(indexPath, "utf-8");

    try {
      await writeFile(indexPath, `${original}\nexport * from "./missing.js";`);

      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("interface-overview", {
          cursor: "start",
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    } finally {
      await writeFile(indexPath, original);
    }
  });

  it("requires complete overview requests for Public Interface Comparison", async () => {
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("public-interface-comparison", {
        after: { resolutionContext, specifier },
        before: { cursor: "start", resolutionContext, specifier },
      })
    );

    expect(outcome).toMatchObject({
      reason: "invalid-request",
      status: "unsupported",
    });
  });

  it.each([
    {
      declaration:
        'export * from "node:fs"; export declare function local(): string;',
      expectedNames: ["local", "readFile"],
      name: "re-export",
      provider:
        'declare module "node:fs" { export function readFile(): string; }',
    },
    {
      declaration:
        "export declare function local(value: typeof process): string;",
      expectedNames: ["added", "local"],
      name: "augmentation",
      provider:
        'import "paged-node-package"; declare global { var process: { pid: number }; } declare module "paged-node-package" { export const added: true; }',
    },
  ])(
    "preserves Node provider $name contributions in export pages and mixed plans",
    async ({ name, declaration, provider, expectedNames }) => {
      const context = nodePath.join(resolutionContext, `node-${name}`);

      const packageRoot = nodePath.join(
        context,
        "node_modules",
        "paged-node-package"
      );

      const providerRoot = nodePath.join(
        context,
        "node_modules",
        "@types",
        "node"
      );

      await Promise.all([
        mkdir(packageRoot, { recursive: true }),
        mkdir(providerRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          nodePath.join(context, "package.json"),
          '{"name":"consumer","dependencies":{"paged-node-package":"1.0.0","@types/node":"1.0.0"}}'
        ),
        writeFile(
          nodePath.join(packageRoot, "package.json"),
          '{"name":"paged-node-package","types":"index.d.ts"}'
        ),
        writeFile(nodePath.join(packageRoot, "index.d.ts"), declaration),
        writeFile(
          nodePath.join(providerRoot, "package.json"),
          '{"name":"@types/node","types":"index.d.ts","dependencies":{"paged-node-package":"1.0.0"}}'
        ),
        writeFile(nodePath.join(providerRoot, "index.d.ts"), provider),
      ]);

      const target = {
        resolutionContext: context,
        specifier: "paged-node-package",
      };

      const { outcome: page } = await Effect.runPromise(
        invokeInspectionCore("interface-overview", {
          ...target,
          cursor: "start",
        })
      );

      expect(page).toMatchObject({
        result: {
          exportPage: { complete: true, totalModuleExports: 2 },
          moduleExports: expectedNames.map((exportNameItem) => ({
            name: exportNameItem,
          })),
        },
        status: "success",
      });

      const { outcome: plan } = await Effect.runPromise(
        invokeInspectionCore("inspection-plan", {
          ...target,
          queries: [
            { cursor: "start", intent: "interface-overview" },
            { exportName: "local", intent: "signature-inspection" },
          ],
        })
      );

      expect(plan).toMatchObject({
        result: {
          inspections: [
            {
              moduleExports: expectedNames.map((exportNameItem) => ({
                name: exportNameItem,
              })),
            },
            { moduleExport: { name: "local" } },
          ],
        },
        status: "success",
      });
    }
  );
});
