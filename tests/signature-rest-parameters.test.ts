import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { ModuleKind, ModuleResolutionKind } from "tsrs/sync";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

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

describe("signature-rest-parameters", () => {
  beforeAll(async () => {
    resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-signature-rest-")
    );

    const packageRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      specifier
    );

    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      nodePath.join(resolutionContext, "package.json"),
      JSON.stringify({ type: "module" })
    );
    await writeFile(
      nodePath.join(packageRoot, "package.json"),
      JSON.stringify({
        name: specifier,
        type: "module",
        types: "index.d.ts",
        version: "1.0.0",
      })
    );
    await writeFile(
      nodePath.join(packageRoot, "index.d.ts"),
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
  `
    );
    const consumerPath = nodePath.join(resolutionContext, "consumer.ts");
    const generatedText1 = REST_CASES.map(([name]) => `${name}();`).join("\n");
    await writeFile(
      consumerPath,
      `import { ${REST_CASES.map(([name]) => name).join(", ")} } from "${specifier}";\n${generatedText1}`
    );

    const program = createFixtureProgram([consumerPath], {
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      noEmit: true,
      strict: true,
      types: [],
    });

    const consumer = program.getSourceFile(consumerPath);
    assert.ok(consumer, "The compiler must load the generated consumer.");

    const diagnostics = program.getSemanticDiagnostics();
    assert.deepEqual(
      diagnostics.filter(
        (diagnostic) => diagnostic.fileName !== consumer.fileName
      ),
      []
    );

    for (const [index, [name]] of REST_CASES.entries()) {
      const call = consumer.statements[index + 1];
      assert.ok(call, "Every rest-parameter case must have a generated call.");

      compilerOmission.set(
        name,
        !diagnostics.some(
          (diagnostic) =>
            diagnostic.pos !== undefined &&
            diagnostic.pos >= call.pos &&
            diagnostic.pos < call.end
        )
      );
    }
  });

  afterAll(async () => {
    if (resolutionContext !== undefined) {
      await rm(resolutionContext, { force: true, recursive: true });
    }
  });

  it.each(REST_CASES)(
    "matches compiler call checking for the %s rest parameter",
    async (exportName, optional) => {
      expect(compilerOmission.get(exportName)).toBe(optional);

      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("signature-inspection", {
          exportName,
          resolutionContext,
          specifier,
        })
      );

      expect(outcome).toMatchObject({
        result: {
          moduleExport: {
            signatures: [{ parameters: [{ optional, rest: true }] }],
          },
        },
        status: "success",
      });
    }
  );
});
