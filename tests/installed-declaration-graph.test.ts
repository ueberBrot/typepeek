import { isModuleDeclaration } from "tsrs/ast";
import { describe, expect, it, vi } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { createCompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import { InstalledDeclarationGraph } from "#typepeek/inspection/installed-declaration-graph";
import { InstalledProgramLoader } from "#typepeek/inspection/installed-program-loader";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

describe("installed declaration graph", () => {
  it("validates ambient import dependencies without one native lookup per reference", () => {
    const fileName = "/declaration-batches/index.d.ts";

    const text = [
      'declare module "target" { export interface Input {',
      ...Array.from(
        { length: 300 },
        (_, index) => `readonly field${index}: import("dependency").Value;`
      ),
      "} }",
      'declare module "dependency" { export interface Value { readonly id: string; } }',
    ].join("\n");

    const program = createFixtureProgram(
      [fileName],
      { noEmit: true, noLib: true },
      [[fileName, text]]
    );

    const { checker } = program.getProject();
    const source = requireDefined(program.getSourceFile(fileName));

    const declaration = requireDefined(
      source.statements.find(isModuleDeclaration)
    );

    const target = requireDefined(
      checker.getSymbolAtLocation(declaration.name)
    );

    const graph = new InstalledDeclarationGraph(
      new InstalledProgramLoader(
        ["/declaration-batches"],
        createCompilerWorkSession()
      )
    );

    const nativeRead = vi.spyOn(checker, "getSymbolAtLocation");

    try {
      graph.assertAmbientModuleResolved(program, checker, target);
      expect(nativeRead.mock.calls.length).toBeLessThan(10);
    } finally {
      nativeRead.mockRestore();
    }
  });

  it("still rejects unresolved imports in an ambient declaration", () => {
    const fileName = "/unresolved-declarations/index.d.ts";

    const program = createFixtureProgram(
      [fileName],
      { noEmit: true, noLib: true },
      [
        [
          fileName,
          'declare module "target" { export type Input = import("missing").Value; }',
        ],
      ]
    );

    const { checker } = program.getProject();
    const source = requireDefined(program.getSourceFile(fileName));

    const declaration = requireDefined(
      source.statements.find(isModuleDeclaration)
    );

    const target = requireDefined(
      checker.getSymbolAtLocation(declaration.name)
    );

    const graph = new InstalledDeclarationGraph(
      new InstalledProgramLoader(
        ["/unresolved-declarations"],
        createCompilerWorkSession()
      )
    );

    expect(() => {
      graph.assertAmbientModuleResolved(program, checker, target);
    }).toThrow(
      "A declaration re-export could not be resolved from Installed Evidence."
    );
  });
});
