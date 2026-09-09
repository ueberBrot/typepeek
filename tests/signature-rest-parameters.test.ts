import ts from "@typescript/typescript6";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "signature-rest-fixture";
const compilerOmission = new Map<string, boolean>();
const REST_CASES = [
  ["required", false],
  ["nested", false],
  ["requiredUnion", false],
  ["variadic", false],
  ["optional", true],
  ["empty", true],
  ["optionalUnion", true],
  ["array", true],
  ["recursive", true],
  ["requiredIntersection", false],
  ["optionalIntersection", true],
  ["brandedArray", false],
  ["brandedEmpty", false],
  ["optionalBrand", true],
  ["neverRest", false],
  ["anyRest", true],
  ["ordinaryArray", true],
  ["intersectionUnion", true],
  ["requiredIntersectionUnion", false],
  ["constrainedIntersection", false],
  ["unionConstraint", true],
] as const;

beforeAll(async () => {
  resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-signature-rest-"));
  const packageRoot = join(resolutionContext, "node_modules", specifier);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(resolutionContext, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: specifier, version: "1.0.0", type: "module", types: "index.d.ts" }),
  );
  await writeFile(
    join(packageRoot, "index.d.ts"),
    `
    export declare function required<T extends [string]>(...args: T): void;
    export declare function nested<T extends [string], U extends T>(...args: U): void;
    export declare function requiredUnion<T extends [string] | [number]>(...args: T): void;
    export declare function variadic<T extends [string, ...string[]]>(...args: T): void;
    export declare function optional<T extends [string?]>(...args: T): void;
    export declare function empty<T extends []>(...args: T): void;
    export declare function optionalUnion<T extends [] | [string]>(...args: T): void;
    export declare function array<T extends unknown[]>(...args: T): void;
    export declare function recursive<T extends T[]>(...args: T): void;
    export declare function requiredIntersection(...args: [string] & { readonly brand: true }): void;
    export declare function optionalIntersection(...args: [string?] & string[]): void;
    export declare function brandedArray(...args: string[] & { readonly brand: true }): void;
    export declare function brandedEmpty(...args: [] & { readonly brand: true }): void;
    export declare function optionalBrand(...args: string[] & { readonly brand?: true }): void;
    export declare function neverRest(...args: never): void;
    export declare function anyRest(...args: any): void;
    export declare function ordinaryArray(...args: string[]): void;
    export declare function intersectionUnion(...args: ([string] & { readonly brand: true }) | []): void;
    export declare function requiredIntersectionUnion(...args: ([string] & { readonly brand: true }) | [number]): void;
    export declare function constrainedIntersection<T extends string[] & { readonly brand: true }>(...args: T): void;
    export declare function unionConstraint<T extends string[]>(...args: T | [number]): void;
  `,
  );
  const consumerPath = join(resolutionContext, "consumer.ts");
  await writeFile(
    consumerPath,
    `import { ${REST_CASES.map(([name]) => name).join(", ")} } from "${specifier}";\n` +
      REST_CASES.map(([name]) => `${name}();`).join("\n"),
  );
  const program = ts.createProgram([consumerPath], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    types: [],
    noEmit: true,
  });
  const consumer = program.getSourceFile(consumerPath);
  expect(consumer).toBeDefined();
  if (consumer === undefined) return;
  const diagnostics = program.getSemanticDiagnostics();
  expect(diagnostics.filter((diagnostic) => diagnostic.file !== consumer)).toEqual([]);
  for (const [index, [name]] of REST_CASES.entries()) {
    const call = consumer.statements[index + 1];
    expect(call).toBeDefined();
    if (call === undefined) continue;
    compilerOmission.set(
      name,
      !diagnostics.some(
        (diagnostic) =>
          diagnostic.start !== undefined &&
          diagnostic.start >= call.pos &&
          diagnostic.start < call.end,
      ),
    );
  }
});

afterAll(async () => {
  if (resolutionContext !== undefined) {
    await rm(resolutionContext, { recursive: true, force: true });
  }
});

it.each(REST_CASES)(
  "matches compiler call checking for the %s rest parameter",
  async (exportName, optional) => {
    expect(compilerOmission.get(exportName)).toBe(optional);
    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("signature-inspection", { resolutionContext, specifier, exportName }),
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "success",
      result: {
        moduleExport: {
          signatures: [{ parameters: [{ rest: true, optional }] }],
        },
      },
    });
  },
);
