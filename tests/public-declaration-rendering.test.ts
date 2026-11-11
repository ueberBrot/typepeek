import { ScriptTarget } from "tsrs/ast";
import type { Declaration } from "tsrs/ast";
import { ModuleKind, ModuleResolutionKind } from "tsrs/async";
import type {
  Checker,
  RawCompilerOptions,
  Symbol as CompilerSymbol,
} from "tsrs/async";
import { describe, expect, it } from "vite-plus/test";

import { declarationsOf } from "#typepeek/inspection/compiler/compiler-session";
import { InspectionResultConstruction } from "#typepeek/inspection/model/result-construction";
import {
  projectPublicDeclaration,
  renderPublicDeclaration,
} from "#typepeek/inspection/projection/declaration-projection";
import { publicDeclarations } from "#typepeek/inspection/projection/public-declaration-selection";
import { createModuleExportInspection } from "#typepeek/inspection/queries/export-inspection";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

interface ExportedDeclarations {
  readonly checker: Checker;
  readonly declarations: readonly Declaration[];
  readonly moduleSymbol: CompilerSymbol;
}

const exportedDeclarations = async function exportedDeclarations(
  sourceText: string,
  exportName: string
): Promise<ExportedDeclarations> {
  const fileName = "/typepeek-public-interface.ts";

  const options: RawCompilerOptions = {
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    noEmit: true,
    noLib: true,
    target: ScriptTarget.ES2024,
  };

  const program = await createFixtureProgram([fileName], options, [
    [fileName, sourceText],
  ]);

  const sourceFile = await program.getSourceFile(fileName);

  if (sourceFile === undefined) {
    throw new Error("The native fixture source is missing.");
  }

  const { checker } = program.getProject();
  const moduleSymbol = await checker.getSymbolAtLocation(sourceFile);

  if (moduleSymbol === undefined) {
    throw new Error("Test source did not create a module symbol.");
  }

  const exportsOfModule = await checker.getExportsOfModule(moduleSymbol);

  const exportedSymbol = exportsOfModule.find(
    (symbol) => symbol.name === exportName
  );

  const declarations = await publicDeclarations(
    checker,
    (await declarationsOf(exportedSymbol)) ?? []
  );

  if (declarations.length === 0) {
    throw new Error(`Test source did not export ${exportName}.`);
  }

  return { checker, declarations, moduleSymbol };
};

const renderExport = async function renderExport(
  sourceText: string,
  exportName: string
): Promise<string> {
  const { checker, declarations } = await exportedDeclarations(
    sourceText,
    exportName
  );

  const mappedValues = await Array.fromAsync(
    declarations,
    async (declaration) => await renderPublicDeclaration(checker, declaration)
  );

  return mappedValues.join("\n");
};

describe("public-declaration-rendering", () => {
  describe("Public Interface declaration rendering", () => {
    it("recovers inferred types while removing source implementation", async () => {
      const source = [
        'const implementationSecret = "hidden";',
        'export const inferred = { mode: "source" as const };',
        `export function createLabel(prefix = "label") { return \`\${prefix}:\${implementationSecret}\`; }`,
        "export namespace Tools {",
        "  const privateValue = implementationSecret;",
        "  export function run() { return privateValue; }",
        "}",
        "export class SourceClass {",
        "  static { void implementationSecret; }",
        '  readonly mode = "source" as const;',
        '  constructor(private readonly label = "label") {}',
        "  private secret = implementationSecret;",
        "  run() { return this.label; }",
        "}",
        "export class Overloaded {",
        "  constructor(value: string);",
        "  constructor(value: string | number) {}",
        "  run(value: string): string;",
        "  run(value: number): number;",
        "  run(value: string | number) { return value; }",
        "}",
        "export function overloaded(value: string): string;",
        "export function overloaded(value: number): number;",
        "export function overloaded(value: string | number) { return value; }",
        "export namespace OverloadedTools {",
        "  export function run(value: string): string;",
        "  export function run(value: string | number) { return String(value); }",
        "  export function unrelated() { return 1; }",
        "}",
        "export class MixedOverloads {",
        "  static run(value: string): string;",
        "  static run(value: string | number) { return String(value); }",
        "  run() { return 1; }",
        "}",
        "export function defaultBeforeRequired(value = 1, label: string) { return label; }",
      ].join("\n");

      expect([
        await renderExport(source, "inferred"),
        await renderExport(source, "createLabel"),
        await renderExport(source, "Tools"),
        await renderExport(source, "SourceClass"),
        await renderExport(source, "Overloaded"),
        await renderExport(source, "overloaded"),
        await renderExport(source, "OverloadedTools"),
        await renderExport(source, "MixedOverloads"),
        await renderExport(source, "defaultBeforeRequired"),
      ]).toStrictEqual([
        'inferred: {\n    mode: "source";\n}',
        "function createLabel(prefix?: string): string;",
        "namespace Tools {\n    export function run(): string;\n}",
        [
          "class SourceClass {",
          '    readonly mode: "source";',
          "    constructor(label?: string);",
          "    run(): string;",
          "}",
        ].join("\n"),
        [
          "class Overloaded {",
          "    constructor(value: string);",
          "    run(value: string): string;",
          "    run(value: number): number;",
          "}",
        ].join("\n"),
        [
          "function overloaded(value: string): string;",
          "function overloaded(value: number): number;",
        ].join("\n"),
        [
          "namespace OverloadedTools {",
          "    export function run(value: string): string;",
          "    export function unrelated(): number;",
          "}",
        ].join("\n"),
        [
          "class MixedOverloads {",
          "    static run(value: string): string;",
          "    run(): number;",
          "}",
        ].join("\n"),
        "function defaultBeforeRequired(value: number | undefined, label: string): string;",
      ]);
    });

    it("removes decorators and private enum initializer expressions", async () => {
      const source = [
        "function hidden(): any { return () => undefined; }",
        "@hidden()",
        "export class Decorated {",
        "  @hidden()",
        "  method() { return 1; }",
        "}",
        "export enum Values {",
        "  First = 1,",
        "  Hidden = hidden(),",
        "}",
      ].join("\n");

      expect([
        await renderExport(source, "Decorated"),
        await renderExport(source, "Values"),
      ]).toStrictEqual([
        "class Decorated {\n    method(): number;\n}",
        "enum Values {\n    First = 1,\n    Hidden\n}",
      ]);
    });

    it("preserves constructor accessibility without exposing private parameters", async () => {
      const source = [
        "export class Token {",
        "  private constructor(",
        "    public readonly visible: string,",
        "    protected count: number,",
        "    private secret: boolean,",
        "  ) { void secret; }",
        '  static create() { return new Token("visible", 1, true); }',
        "}",
        "export class ExtensibleToken {",
        "  protected constructor(secret: string) { void secret; }",
        "}",
      ].join("\n");

      expect([
        await renderExport(source, "Token"),
        await renderExport(source, "ExtensibleToken"),
      ]).toStrictEqual([
        [
          "class Token {",
          "    readonly visible: string;",
          "    protected count: number;",
          "    private constructor();",
          "    static create(): Token;",
          "}",
        ].join("\n"),
        [
          "class ExtensibleToken {",
          "    protected constructor(secret: string);",
          "}",
        ].join("\n"),
      ]);
    });

    it("removes an overload implementation whose equivalent property name uses different syntax", async () => {
      const source = [
        "export declare const key: unique symbol;",
        "declare const alias: typeof key;",
        "declare const symbols: { readonly key: unique symbol };",
        'declare const property: "key";',
        "declare const wrappedSymbols: { readonly key: unique symbol };",
        "export class ComputedOverload {",
        '  ["method"](value: string): string;',
        '  ["method"](value: number): number;',
        "  method(value: string | number) { return value; }",
        "  [key](value: string): string;",
        "  [alias](value: string) { return value; }",
        "  [symbols.key](value: number): number;",
        "  [symbols[property]](value: number) { return value; }",
        "  [wrappedSymbols.key](value: boolean): boolean;",
        '  [wrappedSymbols[("key")]](value: boolean) { return value; }',
        "}",
      ].join("\n");

      await expect(renderExport(source, "ComputedOverload")).resolves.toBe(
        [
          "class ComputedOverload {",
          '    ["method"](value: string): string;',
          '    ["method"](value: number): number;',
          "    [key](value: string): string;",
          "    [symbols.key](value: number): number;",
          "    [wrappedSymbols.key](value: boolean): boolean;",
          "}",
        ].join("\n")
      );
    });

    it("preserves parameter properties declared only by overload implementations", async () => {
      const source = [
        "class Visible {}",
        "export class PublicToken {",
        "  constructor(visible: Visible);",
        "  constructor(public readonly visible: Visible) {}",
        "}",
        "export class PrivateToken {",
        "  private constructor(visible: Visible);",
        "  private constructor(public readonly visible: Visible) {}",
        "}",
      ].join("\n");

      expect([
        await renderExport(source, "PublicToken"),
        await renderExport(source, "PrivateToken"),
      ]).toStrictEqual([
        [
          "class PublicToken {",
          "    readonly visible: Visible;",
          "    constructor(visible: Visible);",
          "}",
        ].join("\n"),
        [
          "class PrivateToken {",
          "    readonly visible: Visible;",
          "    private constructor();",
          "}",
        ].join("\n"),
      ]);
    });

    it("traverses visible parameter properties without leaking hidden private constructor inputs", async () => {
      const source = [
        "class Visible {}",
        "class Secret {}",
        "export class Token {",
        "  private constructor(public visible = new Visible(), secret = new Secret()) {}",
        "}",
      ].join("\n");

      const { checker, declarations } = await exportedDeclarations(
        source,
        "Token"
      );

      const inferred = await Array.fromAsync(
        declarations,
        async (declaration) => {
          const projection = await projectPublicDeclaration(
            checker,
            declaration
          );

          const types = await projection.inferredTypes;

          return await Array.fromAsync(types, async (type) => {
            const symbol = await type.getSymbol();

            return symbol?.name;
          });
        }
      );

      const inferredNames = new Set(inferred.flat());

      expect([
        inferredNames.has("Visible"),
        inferredNames.has("Secret"),
      ]).toStrictEqual([true, false]);
    });

    it("rejects inferred async returns that cannot be authoritative without libraries", async () => {
      await expect(
        renderExport(
          "export async function loadValue() { return 1; }",
          "loadValue"
        )
      ).rejects.toThrow(
        "An inferred async Public Interface cannot be represented statically."
      );
      await expect(
        renderExport("export const loadValue = async () => 1;", "loadValue")
      ).rejects.toThrow(
        "An inferred async Public Interface cannot be represented statically."
      );
      await expect(
        renderExport(
          "export class Loader { readonly loadValue = async () => 1; }",
          "Loader"
        )
      ).rejects.toThrow(
        "An inferred async Public Interface cannot be represented statically."
      );
      await expect(
        renderExport("export const loadValue = (async () => 1);", "loadValue")
      ).rejects.toThrow(
        "An inferred async Public Interface cannot be represented statically."
      );
      await expect(
        renderExport(
          "export const loader = { async load() { return 1; } };",
          "loader"
        )
      ).rejects.toThrow(
        "An inferred async Public Interface cannot be represented statically."
      );
    });

    it("rejects inferred types degraded by unavailable standard libraries", async () => {
      const cases: readonly (readonly [string, string])[] = [
        ["export const values = [1, 2];", "values"],
        ["export function values() { return [1, 2]; }", "values"],
        ["export const promise = Promise.resolve(1);", "promise"],
      ];

      await Array.fromAsync(cases, async ([source, exportName]) => {
        await expect(renderExport(source, exportName)).rejects.toThrow(
          "An inferred Public Interface type cannot be represented statically without standard libraries."
        );
      });
    });

    it("rejects an inferred function-local type that consumers cannot name", async () => {
      await expect(
        renderExport(
          [
            "export function makeLocal() {",
            "  class Local { readonly value = 1; }",
            "  return new Local();",
            "}",
          ].join("\n"),
          "makeLocal"
        )
      ).rejects.toThrow(
        "An inferred Public Interface references an implementation-local type."
      );
    });

    it("rejects a default source expression instead of exposing it", async () => {
      await expect(
        renderExport('export default { secret: "hidden" };', "default")
      ).rejects.toThrow(
        "A source-backed default expression cannot be represented without implementation."
      );
    });

    it("shares traversal across focused inspections and isolates separate plans", async () => {
      const source = Array.from({ length: 16 }, (_, index) => {
        const values = Array.from(
          { length: 260 },
          (_item, offset) => index * 260 + offset
        ).join(", ");

        return `export const tuple${index} = [${values}] as const;`;
      }).join("\n");

      const { checker, moduleSymbol } = await exportedDeclarations(
        source,
        "tuple0"
      );

      const packageIdentity = { name: "projection-fixture" };

      const createInspection = () =>
        createModuleExportInspection(
          {
            checker,
            declarationProvenance: () => ({
              file: "index.ts",
              packageIdentity,
            }),
            moduleSymbol,
            publicSubpaths: Promise.resolve([]),
            resultIdentity: { packageIdentity },
            supportingTypeScope: { kind: "package" },
          },
          InspectionResultConstruction.create({
            identity: { packageIdentity },
            resolutionVariant: { accessStyle: "import" },
            specifier: "projection-fixture",
          })
        );

      const inspection = createInspection();
      await expect(
        inspection.inspectDeclarations("tuple0")
      ).resolves.toMatchObject({
        intent: "declaration-inspection",
        moduleExport: { name: "tuple0" },
      });
      await expect(async () => {
        /* oxlint-disable eslint/no-await-in-loop -- Each inspection consumes the same traversal budget. */
        for (let index = 1; index < 16; index += 1) {
          await inspection.inspectDeclarations(`tuple${index}`);
        }
        /* oxlint-enable eslint/no-await-in-loop */
      }).rejects.toThrow(
        "Inspection exceeded its Supporting Type traversal limit."
      );
      await expect(
        createInspection().inspectDeclarations("tuple15")
      ).resolves.toMatchObject({
        intent: "declaration-inspection",
        moduleExport: { name: "tuple15" },
      });
    });
  });
});
