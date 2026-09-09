import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

let resolutionContext: string;
const specifier = "signature-rest-fixture";

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
  `,
  );
});

afterAll(async () => {
  if (resolutionContext !== undefined) {
    await rm(resolutionContext, { recursive: true, force: true });
  }
});

it.each([
  ["required", false],
  ["nested", false],
  ["requiredUnion", false],
  ["variadic", false],
  ["optional", true],
  ["empty", true],
  ["optionalUnion", true],
  ["array", true],
  ["recursive", true],
] as const)(
  "reports whether the generic %s rest parameter may be omitted",
  async (exportName, optional) => {
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
