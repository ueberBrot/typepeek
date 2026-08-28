import ts from "@typescript/typescript6";
import { describe, expect, it } from "vite-plus/test";

import {
  projectPublicDeclaration,
  publicDeclarations,
  renderPublicDeclaration,
} from "#typepeek/inspection/declaration-projection";

describe("Public Interface declaration rendering", () => {
  it("recovers inferred types while removing source implementation", () => {
    const source = [
      'const implementationSecret = "hidden";',
      'export const inferred = { mode: "source" as const };',
      'export function createLabel(prefix = "label") { return `${prefix}:${implementationSecret}`; }',
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

    expect(renderExport(source, "inferred")).toBe('inferred: { mode: "source"; }');
    expect(renderExport(source, "createLabel")).toBe(
      "function createLabel(prefix?: string): string;",
    );
    expect(renderExport(source, "Tools")).toBe(
      "namespace Tools {\n    export function run(): string;\n}",
    );
    expect(renderExport(source, "SourceClass")).toBe(
      [
        "class SourceClass {",
        '    readonly mode: "source";',
        "    constructor(label?: string);",
        "    run(): string;",
        "}",
      ].join("\n"),
    );
    expect(renderExport(source, "Overloaded")).toBe(
      [
        "class Overloaded {",
        "    constructor(value: string);",
        "    run(value: string): string;",
        "    run(value: number): number;",
        "}",
      ].join("\n"),
    );
    expect(renderExport(source, "overloaded")).toBe(
      [
        "function overloaded(value: string): string;",
        "function overloaded(value: number): number;",
      ].join("\n"),
    );
    expect(renderExport(source, "OverloadedTools")).toBe(
      [
        "namespace OverloadedTools {",
        "    export function run(value: string): string;",
        "    export function unrelated(): number;",
        "}",
      ].join("\n"),
    );
    expect(renderExport(source, "MixedOverloads")).toBe(
      [
        "class MixedOverloads {",
        "    static run(value: string): string;",
        "    run(): number;",
        "}",
      ].join("\n"),
    );
    expect(renderExport(source, "defaultBeforeRequired")).toBe(
      "function defaultBeforeRequired(value: number | undefined, label: string): string;",
    );
  });

  it("removes decorators and private enum initializer expressions", () => {
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

    expect(renderExport(source, "Decorated")).toBe("class Decorated {\n    method(): number;\n}");
    expect(renderExport(source, "Values")).toBe("enum Values {\n    First = 1,\n    Hidden\n}");
  });

  it("preserves constructor accessibility without exposing private parameters", () => {
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

    expect(renderExport(source, "Token")).toBe(
      [
        "class Token {",
        "    readonly visible: string;",
        "    protected count: number;",
        "    private constructor();",
        "    static create(): Token;",
        "}",
      ].join("\n"),
    );
    expect(renderExport(source, "ExtensibleToken")).toBe(
      ["class ExtensibleToken {", "    protected constructor(secret: string);", "}"].join("\n"),
    );
  });

  it("removes an overload implementation whose equivalent property name uses different syntax", () => {
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

    expect(renderExport(source, "ComputedOverload")).toBe(
      [
        "class ComputedOverload {",
        '    ["method"](value: string): string;',
        '    ["method"](value: number): number;',
        "    [key](value: string): string;",
        "    [symbols.key](value: number): number;",
        "    [wrappedSymbols.key](value: boolean): boolean;",
        "}",
      ].join("\n"),
    );
  });

  it("preserves parameter properties declared only by overload implementations", () => {
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

    expect(renderExport(source, "PublicToken")).toBe(
      [
        "class PublicToken {",
        "    readonly visible: Visible;",
        "    constructor(visible: Visible);",
        "}",
      ].join("\n"),
    );
    expect(renderExport(source, "PrivateToken")).toBe(
      [
        "class PrivateToken {",
        "    readonly visible: Visible;",
        "    private constructor();",
        "}",
      ].join("\n"),
    );
  });

  it("traverses visible parameter properties without leaking hidden private constructor inputs", () => {
    const source = [
      "class Visible {}",
      "class Secret {}",
      "export class Token {",
      "  private constructor(public visible = new Visible(), secret = new Secret()) {}",
      "}",
    ].join("\n");
    const { checker, declarations } = exportedDeclarations(source, "Token");
    const inferredNames = declarations.flatMap((declaration) =>
      projectPublicDeclaration(checker, declaration).inferredTypes.map((type) =>
        type.symbol?.getName(),
      ),
    );

    expect(inferredNames).toContain("Visible");
    expect(inferredNames).not.toContain("Secret");
  });

  it("rejects inferred async returns that cannot be authoritative without libraries", () => {
    expect(() =>
      renderExport("export async function loadValue() { return 1; }", "loadValue"),
    ).toThrow("An inferred async Public Interface cannot be represented statically.");
    expect(() => renderExport("export const loadValue = async () => 1;", "loadValue")).toThrow(
      "An inferred async Public Interface cannot be represented statically.",
    );
    expect(() =>
      renderExport("export class Loader { readonly loadValue = async () => 1; }", "Loader"),
    ).toThrow("An inferred async Public Interface cannot be represented statically.");
    expect(() => renderExport("export const loadValue = (async () => 1);", "loadValue")).toThrow(
      "An inferred async Public Interface cannot be represented statically.",
    );
    expect(() =>
      renderExport("export const loader = { async load() { return 1; } };", "loader"),
    ).toThrow("An inferred async Public Interface cannot be represented statically.");
  });

  it("rejects inferred types degraded by unavailable standard libraries", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["export const values = [1, 2];", "values"],
      ["export function values() { return [1, 2]; }", "values"],
      ["export const promise = Promise.resolve(1);", "promise"],
    ];
    for (const [source, exportName] of cases) {
      expect(() => renderExport(source, exportName)).toThrow(
        "An inferred Public Interface type cannot be represented statically without standard libraries.",
      );
    }
  });

  it("rejects an inferred function-local type that consumers cannot name", () => {
    expect(() =>
      renderExport(
        [
          "export function makeLocal() {",
          "  class Local { readonly value = 1; }",
          "  return new Local();",
          "}",
        ].join("\n"),
        "makeLocal",
      ),
    ).toThrow("An inferred Public Interface references an implementation-local type.");
  });

  it("rejects a default source expression instead of exposing it", () => {
    expect(() => renderExport('export default { secret: "hidden" };', "default")).toThrow(
      "A source-backed default expression cannot be represented without implementation.",
    );
  });

  it("charges declaration projections to one caller-owned traversal budget", () => {
    const first = exportedDeclarations("export type First = string;", "First");
    let reservations = 0;
    let limit = Number.POSITIVE_INFINITY;
    const context = {
      moduleSymbol: first.moduleSymbol,
      reserveTraversal: () => {
        reservations += 1;
        if (reservations > limit) {
          throw new Error("aggregate projection traversal exhausted");
        }
      },
      reserveTypeTraversal: () => {},
      validatedTypes: new Set<ts.Type>(),
    };
    expect(
      projectPublicDeclaration(first.checker, first.declarations[0]!, context).syntax,
    ).toBeDefined();
    limit = reservations;

    expect(
      () => projectPublicDeclaration(first.checker, first.declarations[0]!, context).syntax,
    ).toThrow("aggregate projection traversal exhausted");
  });
});

function renderExport(sourceText: string, exportName: string): string {
  const { checker, declarations } = exportedDeclarations(sourceText, exportName);
  return declarations
    .map((declaration) => renderPublicDeclaration(checker, declaration))
    .join("\n");
}

function exportedDeclarations(
  sourceText: string,
  exportName: string,
): {
  readonly checker: ts.TypeChecker;
  readonly declarations: readonly ts.Declaration[];
  readonly moduleSymbol: ts.Symbol;
} {
  const fileName = "/typepeek-public-interface.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noLib: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const program = ts.createProgram({
    rootNames: [fileName],
    options,
    host: {
      ...defaultHost,
      fileExists: (candidate) => candidate === fileName,
      getSourceFile: (candidate) => (candidate === fileName ? sourceFile : undefined),
      readFile: (candidate) => (candidate === fileName ? sourceText : undefined),
    },
  });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error("Test source did not create a module symbol.");
  }
  const exportedSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);
  const declarations = publicDeclarations(checker, exportedSymbol?.declarations ?? []);
  if (declarations.length === 0) {
    throw new Error(`Test source did not export ${exportName}.`);
  }
  return { checker, declarations, moduleSymbol };
}
