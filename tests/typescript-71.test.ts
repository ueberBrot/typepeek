import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { ScriptTarget } from "tsrs/ast";
import { ModuleKind, ModuleResolutionKind } from "tsrs/sync";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { invokeInspectionCore } from "#typepeek/inspection/core";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

const specifier = "typescript-71-fixture";
let resolutionContext: string;
let packageRoot: string;

describe("TypeScript 7.1 Public Interfaces", () => {
  beforeAll(async () => {
    resolutionContext = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "typepeek-ts71-"))
    );
    packageRoot = nodePath.join(resolutionContext, "node_modules", specifier);
    await mkdir(packageRoot, { recursive: true });

    const files = [
      [
        "package.json",
        JSON.stringify({
          exports: {
            "./attributes": "./attributes.ts",
            "./es2026": "./es2026.ts",
            "./source": "./source.ts",
          },
          name: specifier,
          type: "module",
          version: "1.0.0",
        }),
      ],
      [
        "assets.d.ts",
        [
          'declare module "*" with { type: "text" } { const content: string; export default content; }',
          'declare module "*" with { type: "bytes" } { const content: Uint8Array<ArrayBuffer>; export default content; }',
        ].join("\n"),
      ],
      [
        "attributes.ts",
        [
          '/// <reference path="./assets.d.ts" />',
          'import text from "./absent.asset" with { type: "text" };',
          'import bytes from "./absent.asset" with { type: "bytes" };',
          "export const textAsset = text;",
          "export const byteAsset = bytes;",
        ].join("\n"),
      ],
      [
        "source.ts",
        [
          '/// <reference lib="esnext" />',
          'import source moduleSource from "./module.js";',
          "export const compiledSource = moduleSource;",
        ].join("\n"),
      ],
      ["module.d.ts", "export declare const runtimeOnly: number;"],
      [
        "module.js",
        'throw new Error("Static inspection must not execute source imports.");',
      ],
      [
        "es2026.ts",
        [
          '/// <reference lib="es2026" />',
          "export const decode = (text: string) => Uint8Array.fromHex(text);",
          "export const upsert = <K, V>(map: Map<K, V>, key: K, make: (key: K) => V) => map.getOrInsertComputed(key, make);",
        ].join("\n"),
      ],
    ] as const;

    await Promise.all(
      files.map(async ([file, text]) => {
        await writeFile(nodePath.join(packageRoot, file), text);
      })
    );

    await writeFile(
      nodePath.join(resolutionContext, "package.json"),
      '{"type":"module"}'
    );
  });

  afterAll(async () => {
    await rm(resolutionContext, { force: true, recursive: true });
  });

  it.each([
    ["attributes", "textAsset", "string"],
    ["attributes", "byteAsset", "Uint8Array<ArrayBuffer>"],
    ["source", "compiledSource", "AbstractModuleSource"],
  ])("preserves the inferred %s/%s type", async (entry, exportName, type) => {
    const file = nodePath.join(packageRoot, `${entry}.ts`);

    const program = createFixtureProgram([file], {
      lib: ["esnext"],
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ScriptTarget.ESNext,
      types: [],
    });

    expect(program.getSyntacticDiagnostics()).toStrictEqual([]);
    expect(program.getSemanticDiagnostics()).toStrictEqual([]);

    const { outcome } = await Effect.runPromise(
      invokeInspectionCore("export-inspection", {
        exportName,
        resolutionContext,
        specifier: `${specifier}/${entry}`,
      })
    );

    expect(outcome).toMatchObject({
      result: {
        moduleExport: {
          spaces: [{ declarations: [{ text: `${exportName}: ${type}` }] }],
        },
      },
      status: "success",
    });
  });

  it.each([
    ["decode", "(text: string): Uint8Array<ArrayBuffer>"],
    ["upsert", "<K, V>(map: Map<K, V>, key: K, make: (key: K) => V): V"],
  ])(
    "uses explicitly referenced ES2026 declarations to infer %s",
    async (exportName, text) => {
      const file = nodePath.join(packageRoot, "es2026.ts");

      const program = createFixtureProgram([file], {
        lib: ["es2026"],
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ScriptTarget.ES2026,
        types: [],
      });

      expect(program.getSyntacticDiagnostics()).toStrictEqual([]);
      expect(program.getSemanticDiagnostics()).toStrictEqual([]);

      const { outcome } = await Effect.runPromise(
        invokeInspectionCore("signature-inspection", {
          exportName,
          resolutionContext,
          specifier: `${specifier}/es2026`,
        })
      );

      expect(outcome).toMatchObject({
        result: { moduleExport: { signatures: [{ text }] } },
        status: "success",
      });
    }
  );
});
