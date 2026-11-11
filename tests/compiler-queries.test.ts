import { isTypeAliasDeclaration, isTypeReferenceNode } from "tsrs/ast";
import type { Node, SourceFile } from "tsrs/ast";
import { API } from "tsrs/async";
import { createFileSystem, createFileSystemLayer } from "tsrs/fs";
import { describe, expect, it, vi } from "vite-plus/test";

import { COMPILER_EXECUTABLE } from "#typepeek/inspection/compiler/compiler-distribution";
import {
  aliasedSymbol,
  symbolAtLocation,
  symbolsAtLocations,
} from "#typepeek/inspection/compiler/compiler-queries";
import { declarationsOf } from "#typepeek/inspection/compiler/compiler-session";
import { requireDefined } from "#typepeek/shared/defined-value";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

const referenceNodes = (file: SourceFile): readonly Node[] =>
  file.statements.flatMap((statement) =>
    isTypeAliasDeclaration(statement)
      ? [
          isTypeReferenceNode(statement.type)
            ? statement.type.typeName
            : statement.type,
        ]
      : []
  );

describe("native compiler queries", () => {
  it("reuses alias targets only within the checker that resolved them", async () => {
    const fileName = "/query-aliases.d.ts";

    const createProgram = async (target: string) =>
      await createFixtureProgram([fileName], { noEmit: true, noLib: true }, [
        [fileName, `interface ${target} {} export { ${target} as Selected };`],
      ]);

    const firstProgram = await createProgram("Before");
    const secondProgram = await createProgram("After");
    const firstChecker = firstProgram.getProject().checker;
    const secondChecker = secondProgram.getProject().checker;

    const nativeRead = vi.spyOn(firstChecker, "getAliasedSymbol");
    const secondRead = vi.spyOn(secondChecker, "getAliasedSymbol");

    try {
      const firstAlias = requireDefined(
        await firstChecker.getSymbolAtLocation(
          requireDefined(await firstProgram.getSourceFile(fileName))
        )
      );

      const secondAlias = requireDefined(
        await secondChecker.getSymbolAtLocation(
          requireDefined(await secondProgram.getSourceFile(fileName))
        )
      );

      const beforeExports = await firstChecker.getExportsOfModule(firstAlias);
      const before = requireDefined(beforeExports[0]);

      const afterExports = await secondChecker.getExportsOfModule(secondAlias);
      const after = requireDefined(afterExports[0]);

      const targetSymbol = await aliasedSymbol(firstChecker, before);
      const targetSymbolResult = await aliasedSymbol(firstChecker, before);
      const targetSymbolResult2 = await aliasedSymbol(secondChecker, after);
      const targetSymbolResult3 = await aliasedSymbol(secondChecker, after);
      expect([
        targetSymbol.name,
        targetSymbolResult.name,
        targetSymbolResult2.name,
        targetSymbolResult3.name,
      ]).toStrictEqual(["Before", "Before", "After", "After"]);
      expect(nativeRead).toHaveBeenCalledOnce();
      expect(secondRead).toHaveBeenCalledOnce();
    } finally {
      nativeRead.mockRestore();
      secondRead.mockRestore();
    }
  });

  it("preserves order and cached misses across bounded native batches", async () => {
    const fileName = "/query-batches.d.ts";

    const text = [
      "interface Value { readonly enabled: true; }",
      ...Array.from(
        { length: 300 },
        (_, index) => `export type Use${index} = Value;`
      ),
      "export type Primitive = string;",
    ].join("\n");

    const program = await createFixtureProgram(
      [fileName],
      { noEmit: true, noLib: true },
      [[fileName, text]]
    );

    const nodes = referenceNodes(
      requireDefined(await program.getSourceFile(fileName))
    );

    const { checker } = program.getProject();

    const nativeRead = vi.spyOn(checker, "getSymbolAtLocation");

    try {
      const symbols = await symbolsAtLocations(checker, nodes);
      expect(symbols.map((symbol) => symbol?.name)).toStrictEqual([
        ...Array.from({ length: 300 }, () => "Value"),
        undefined,
      ]);
      expect(nativeRead.mock.calls.length).toBeLessThan(nodes.length / 4);
      expect(
        nativeRead.mock.calls.every(
          ([locations]) => Array.isArray(locations) && locations.length <= 128
        )
      ).toBeTruthy();
      const calls = nativeRead.mock.calls.length;
      const missing = requireDefined(nodes.at(-1));
      const first = requireDefined(nodes[0]);

      const symbolsAtLocationsResult = await symbolsAtLocations(checker, [
        missing,
        first,
        missing,
      ]);

      expect([
        await symbolAtLocation(checker, missing),
        ...symbolsAtLocationsResult.map((symbol) => symbol?.name),
      ]).toStrictEqual([undefined, undefined, "Value", undefined]);
      expect(nativeRead).toHaveBeenCalledTimes(calls);
    } finally {
      nativeRead.mockRestore();
    }
  });

  it("keeps bindings separate when a later snapshot changes a global", async () => {
    const main = "/query-snapshots/main.d.ts";
    const global = "/query-snapshots/global.d.ts";

    await using api = new API({
      runExternalCode: false,
      tsserverPath: COMPILER_EXECUTABLE,
    });

    const createPrograms = [
      {
        compilerOptions: { noEmit: true, noLib: true },
        rootFiles: [main, global],
      },
    ];

    await using before = await api.createSnapshot({
      createPrograms,
      fileSystem: createFileSystem([
        [main, "export type Selected = Global;"],
        [global, "interface Global { readonly before: true; }"],
      ]),
    });

    const beforeProgram = requireDefined(
      before.operation?.createdPrograms?.[0]
    );

    const node = requireDefined(
      referenceNodes(requireDefined(await beforeProgram.getSourceFile(main)))[0]
    );

    const beforeChecker = beforeProgram.getProject().checker;
    const symbolResult = await symbolAtLocation(beforeChecker, node);
    expect(symbolResult?.name).toBe("Global");

    await using after = await before.update({
      createPrograms,
      fileSystem: createFileSystemLayer([
        [global, "interface Global { readonly after: true; }"],
      ]),
    });

    const afterProgram = requireDefined(after.operation?.createdPrograms?.[0]);
    const afterChecker = afterProgram.getProject().checker;

    const afterDeclarations = await declarationsOf(
      await symbolAtLocation(afterChecker, node)
    );

    expect(afterDeclarations[0]?.getText()).toContain("readonly after");

    const beforeDeclarations = await declarationsOf(
      await symbolAtLocation(beforeChecker, node)
    );

    expect(beforeDeclarations[0]?.getText()).toContain("readonly before");
  });
});
