import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import {
  invokeInspectionCore,
  type InspectionCoreInvocationReceipt,
} from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "large-declaration-package";

beforeAll(async () => {
  resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-large-declarations-"));
  const packageRoot = join(resolutionContext, "node_modules", specifier);
  const dependencyRoot = join(resolutionContext, "node_modules", "shared-types");
  const selfRoot = join(resolutionContext, "node_modules", "self-referencing-package");
  await mkdir(join(packageRoot, "declarations"), { recursive: true });
  await mkdir(dependencyRoot, { recursive: true });
  await mkdir(selfRoot, { recursive: true });
  await Promise.all([
    writeFile(
      join(resolutionContext, "package.json"),
      JSON.stringify({
        name: "consumer",
        dependencies: { [specifier]: "1.0.0", "self-referencing-package": "1.0.0" },
      }),
    ),
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: specifier,
        version: "1.0.0",
        types: "index.d.ts",
        dependencies: { "shared-types": "1.0.0" },
      }),
    ),
    writeFile(
      join(dependencyRoot, "package.json"),
      JSON.stringify({ name: "shared-types", version: "1.0.0", types: "index.d.ts" }),
    ),
    writeFile(join(dependencyRoot, "index.d.ts"), "export interface Input { value: string; }"),
    writeFile(
      join(selfRoot, "package.json"),
      JSON.stringify({
        name: "self-referencing-package",
        version: "1.0.0",
        exports: { ".": "./index.d.ts", "./input": "./input.d.ts" },
      }),
    ),
    writeFile(
      join(selfRoot, "index.d.ts"),
      'import type { Input } from "self-referencing-package/input"; export declare function inspect(value: Input): string;',
    ),
    writeFile(join(selfRoot, "input.d.ts"), "export interface Input { value: string; }"),
    ...Array.from({ length: 600 }, (_, index) =>
      writeFile(
        join(packageRoot, "declarations", `entry-${index}.d.ts`),
        `import type { Input } from "shared-types";
         export declare function entry${index}(input: Input): string;`,
      ),
    ),
    writeFile(
      join(packageRoot, "index.d.ts"),
      Array.from(
        { length: 600 },
        (_, index) => `export { entry${index} } from "./declarations/entry-${index}.js";`,
      ).join("\n"),
    ),
  ]);
});

it("resolves a package's own Public Subpath without a dependency on itself", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("signature-inspection", {
      resolutionContext,
      specifier: "self-referencing-package",
      exportName: "inspect",
    }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: { moduleExport: { signatures: [{ text: "(value: Input): string" }] } },
  });
});

afterAll(async () => {
  if (resolutionContext !== undefined) {
    await rm(resolutionContext, { recursive: true, force: true });
  }
});

it("inspects one export in a large declaration graph with shared dependencies", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("signature-inspection", {
      resolutionContext,
      specifier,
      exportName: "entry599",
    }),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      moduleExport: {
        name: "entry599",
        signatures: [{ kind: "call", text: "(input: Input): string" }],
      },
    },
  });
});

it("pages a large Module Export index without gaps or duplicate names", async () => {
  const names: string[] = [];
  let cursor: string | undefined = "start";
  while (cursor !== undefined) {
    const { outcome }: InspectionCoreInvocationReceipt<"interface-overview"> =
      await Effect.runPromise(
        invokeInspectionCore("interface-overview", { resolutionContext, specifier, cursor }),
      );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: { exportPage: { cursor, totalModuleExports: 600, complete: false } },
    });
    if (outcome.status !== "success") return;
    expect(outcome.result.moduleExports.length).toBe(100);
    names.push(...outcome.result.moduleExports.map(({ name }) => name));
    cursor = outcome.result.exportPage?.nextCursor;
  }
  expect(names).toHaveLength(600);
  expect(new Set(names).size).toBe(600);
  expect(names).toContain("entry599");
});

it("rejects continuation from another Resolution Variant", async () => {
  const { outcome: first } = await Effect.runPromise(
    invokeInspectionCore("interface-overview", {
      resolutionContext,
      specifier,
      cursor: "start",
      accessStyle: "import",
    }),
  );
  expect(first.status).toBe("success");
  if (first.status !== "success") return;
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("interface-overview", {
      resolutionContext,
      specifier,
      cursor: first.result.exportPage?.nextCursor,
      accessStyle: "require",
    }),
  );
  expect(outcome).toMatchObject({ status: "unsupported", reason: "invalid-request" });
});

it("rejects an export cursor after the index changes", async () => {
  const indexPath = join(resolutionContext, "node_modules", specifier, "index.d.ts");
  const original = await readFile(indexPath, "utf8");
  const { outcome: first } = await Effect.runPromise(
    invokeInspectionCore("interface-overview", {
      resolutionContext,
      specifier,
      cursor: "start",
    }),
  );
  expect(first.status).toBe("success");
  if (first.status !== "success") return;
  try {
    await writeFile(indexPath, `${original}\nexport declare const added: string;`);
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", {
        resolutionContext,
        specifier,
        cursor: first.result.exportPage?.nextCursor,
      }),
    );
    expect(outcome).toMatchObject({ status: "unsupported", reason: "invalid-request" });
    const { outcome: restarted } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", {
        resolutionContext,
        specifier,
        cursor: "start",
      }),
    );
    expect(restarted).toMatchObject({
      status: "success",
      result: {
        exportPage: { totalModuleExports: 601 },
        moduleExports: expect.arrayContaining([{ name: "added" }]),
      },
    });
  } finally {
    await writeFile(indexPath, original);
  }
});

it("does not present an unresolved re-export graph as an export page", async () => {
  const indexPath = join(resolutionContext, "node_modules", specifier, "index.d.ts");
  const original = await readFile(indexPath, "utf8");
  try {
    await writeFile(indexPath, `${original}\nexport * from "./missing.js";`);
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", {
        resolutionContext,
        specifier,
        cursor: "start",
      }),
    );
    expect(outcome).toMatchObject({ status: "unsupported", reason: "unsupported-evidence" });
  } finally {
    await writeFile(indexPath, original);
  }
});

it("requires complete overview requests for Public Interface Comparison", async () => {
  const { outcome } = await Effect.runPromise(
    invokeInspectionCore("public-interface-comparison", {
      before: { resolutionContext, specifier, cursor: "start" },
      after: { resolutionContext, specifier },
    }),
  );
  expect(outcome).toMatchObject({ status: "unsupported", reason: "invalid-request" });
});

it.each([
  {
    name: "re-export",
    declaration: 'export * from "node:fs"; export declare function local(): string;',
    provider: 'declare module "node:fs" { export function readFile(): string; }',
    expectedNames: ["local", "readFile"],
  },
  {
    name: "augmentation",
    declaration: "export declare function local(value: typeof process): string;",
    provider:
      'import "paged-node-package"; declare global { var process: { pid: number }; } declare module "paged-node-package" { export const added: true; }',
    expectedNames: ["added", "local"],
  },
])(
  "preserves Node provider $name contributions in export pages and mixed plans",
  async ({ name, declaration, provider, expectedNames }) => {
    const context = join(resolutionContext, `node-${name}`);
    const packageRoot = join(context, "node_modules", "paged-node-package");
    const providerRoot = join(context, "node_modules", "@types", "node");
    await Promise.all([
      mkdir(packageRoot, { recursive: true }),
      mkdir(providerRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(context, "package.json"),
        '{"name":"consumer","dependencies":{"paged-node-package":"1.0.0","@types/node":"1.0.0"}}',
      ),
      writeFile(
        join(packageRoot, "package.json"),
        '{"name":"paged-node-package","types":"index.d.ts"}',
      ),
      writeFile(join(packageRoot, "index.d.ts"), declaration),
      writeFile(
        join(providerRoot, "package.json"),
        '{"name":"@types/node","types":"index.d.ts","dependencies":{"paged-node-package":"1.0.0"}}',
      ),
      writeFile(join(providerRoot, "index.d.ts"), provider),
    ]);
    const target = { resolutionContext: context, specifier: "paged-node-package" };
    const { outcome: page } = await Effect.runPromise(
      invokeInspectionCore("interface-overview", { ...target, cursor: "start" }),
    );
    expect(page, JSON.stringify(page)).toMatchObject({
      status: "success",
      result: {
        moduleExports: expectedNames.map((name) => ({ name })),
        exportPage: { totalModuleExports: 2, complete: true },
      },
    });
    const { outcome: plan } = await Effect.runPromise(
      invokeInspectionCore("inspection-plan", {
        ...target,
        queries: [
          { intent: "interface-overview", cursor: "start" },
          { intent: "signature-inspection", exportName: "local" },
        ],
      }),
    );
    expect(plan, JSON.stringify(plan)).toMatchObject({
      status: "success",
      result: {
        inspections: [
          { moduleExports: expectedNames.map((name) => ({ name })) },
          { moduleExport: { name: "local" } },
        ],
      },
    });
  },
);
