import { isTypeAliasDeclaration, isTypeReferenceNode } from "tsrs/ast";
import type { Node, SourceFile } from "tsrs/ast";
import { createFileSystem, createFileSystemLayer } from "tsrs/fs";
import { API } from "tsrs/sync";
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
  it("reuses alias targets only within the checker that resolved them", () => {
    const fileName = "/query-aliases.d.ts";

    const createProgram = (target: string) =>
      createFixtureProgram([fileName], { noEmit: true, noLib: true }, [
        [fileName, `interface ${target} {} export { ${target} as Selected };`],
      ]);

    const firstProgram = createProgram("Before");
    const secondProgram = createProgram("After");
    const firstChecker = firstProgram.getProject().checker;
    const secondChecker = secondProgram.getProject().checker;
    expect(firstChecker.getAliasedSymbol).toBeTypeOf("function");
    expect(secondChecker.getAliasedSymbol).toBeTypeOf("function");
    const nativeRead = vi.spyOn(firstChecker, "getAliasedSymbol");
    const secondRead = vi.spyOn(secondChecker, "getAliasedSymbol");

    try {
      const firstAlias = requireDefined(
        firstChecker.getSymbolAtLocation(
          requireDefined(firstProgram.getSourceFile(fileName))
        )
      );

      const secondAlias = requireDefined(
        secondChecker.getSymbolAtLocation(
          requireDefined(secondProgram.getSourceFile(fileName))
        )
      );

      const before = requireDefined(
        firstChecker.getExportsOfModule(firstAlias)[0]
      );

      const after = requireDefined(
        secondChecker.getExportsOfModule(secondAlias)[0]
      );

      expect([
        aliasedSymbol(firstChecker, before).name,
        aliasedSymbol(firstChecker, before).name,
        aliasedSymbol(secondChecker, after).name,
        aliasedSymbol(secondChecker, after).name,
      ]).toStrictEqual(["Before", "Before", "After", "After"]);
      expect(nativeRead).toHaveBeenCalledOnce();
      expect(secondRead).toHaveBeenCalledOnce();
    } finally {
      nativeRead.mockRestore();
      secondRead.mockRestore();
    }
  });

  it("preserves order and cached misses across bounded native batches", () => {
    const fileName = "/query-batches.d.ts";

    const text = [
      "interface Value { readonly enabled: true; }",
      ...Array.from(
        { length: 300 },
        (_, index) => `export type Use${index} = Value;`
      ),
      "export type Primitive = string;",
    ].join("\n");

    const program = createFixtureProgram(
      [fileName],
      { noEmit: true, noLib: true },
      [[fileName, text]]
    );

    const nodes = referenceNodes(
      requireDefined(program.getSourceFile(fileName))
    );

    const { checker } = program.getProject();
    expect(checker.getSymbolAtLocation).toBeTypeOf("function");
    const nativeRead = vi.spyOn(checker, "getSymbolAtLocation");

    try {
      const symbols = symbolsAtLocations(checker, nodes);
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
      expect([
        symbolAtLocation(checker, missing),
        ...symbolsAtLocations(checker, [missing, first, missing]).map(
          (symbol) => symbol?.name
        ),
      ]).toStrictEqual([undefined, undefined, "Value", undefined]);
      expect(nativeRead).toHaveBeenCalledTimes(calls);
    } finally {
      nativeRead.mockRestore();
    }
  });

  it("keeps bindings separate when a later snapshot changes a global", () => {
    const main = "/query-snapshots/main.d.ts";
    const global = "/query-snapshots/global.d.ts";

    using api = new API({
      runExternalCode: false,
      tsserverPath: COMPILER_EXECUTABLE,
    });

    const createPrograms = [
      {
        compilerOptions: { noEmit: true, noLib: true },
        rootFiles: [main, global],
      },
    ];

    using before = api.createSnapshot({
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
      referenceNodes(requireDefined(beforeProgram.getSourceFile(main)))[0]
    );

    const beforeChecker = beforeProgram.getProject().checker;
    expect(symbolAtLocation(beforeChecker, node)?.name).toBe("Global");

    using after = before.update({
      createPrograms,
      fileSystem: createFileSystemLayer([
        [global, "interface Global { readonly after: true; }"],
      ]),
    });

    const afterProgram = requireDefined(after.operation?.createdPrograms?.[0]);
    const afterChecker = afterProgram.getProject().checker;

    expect(
      declarationsOf(symbolAtLocation(afterChecker, node))[0]?.getText()
    ).toContain("readonly after");
    expect(
      declarationsOf(symbolAtLocation(beforeChecker, node))[0]?.getText()
    ).toContain("readonly before");
  });
});
