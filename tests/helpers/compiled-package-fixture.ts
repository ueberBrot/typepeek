import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { Schema } from "effect";
import { Predicate } from "effect";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";

import {
  installPackedPackagesWithNpm,
  packPackage,
} from "./package-toolchain.ts";

const PATTERN_DECLARATION_TARGET = "./dist/patterns/*.d.ts";
const ROOT_EXPORT_DECLARATION = "export declare const rootExport: string;\n";
const DIST_DECLARATION_ENTRY = "./dist/index.d.ts";
const DIST_RUNTIME_ENTRY = "./dist/index.js";

const RED_EXPORT_DECLARATION =
  "export declare const redPatternExport: string;\n";

const MISSING_DECLARATION_TARGET = "./dist/missing/*.d.ts";
const VISIBLE_EXPORT_DECLARATION = "export declare const visible: string;";
const READONLY_ID_DECLARATION = "  readonly id: string;";
const PACKAGE_MANIFEST_FILE = "package.json";
const FIXTURE_SCOPE = "@typepeek-fixture";

interface PackageSource {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly declaration: string;
  readonly additionalDeclarations?: Readonly<Record<string, string>>;
  readonly installedManifest?: string | Schema.JsonObject;
  readonly runtime: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: Schema.Json;
}

const nestedExportTarget = function nestedExportTarget(
  depth: number
): Schema.JsonObject {
  let target: Schema.JsonObject = { types: PATTERN_DECLARATION_TARGET };

  for (let index = 0; index < depth; index += 1) {
    target = { node: target };
  }

  return target;
};

const fixturePadding = function fixturePadding(bytes: number): string {
  // Vary each block to keep large fixtures below npm's tar compression-ratio limit.
  return Array.from({ length: Math.ceil(bytes / 64) }, (_, index) =>
    index.toString(36).padStart(64, "x")
  )
    .join("")
    .slice(0, bytes);
};

const broadSupportingTypesParts1 = Array.from(
  { length: 97 },
  (_, index) => `Supporting${index}`
).join(", ");

const aggregateOutputParts2 = Array.from(
  { length: 48 },
  (_, index) => `Aggregate${index}`
).join(", ");

const wideSignatureParts3 = Array.from(
  { length: 1200 },
  (_, index) => `readonly property${index}: string;`
).join(" ");

const broadParametersParts4 = Array.from(
  { length: 257 },
  (_, index) => `parameter${index}: number`
).join(", ");

const broadTypeParametersParts5 = Array.from(
  { length: 65 },
  (_, index) => `Type${index}`
).join(", ");

const detailedWideSignatureParts6 = Array.from(
  { length: 450 },
  (_, index) => `readonly property${index}: string;`
).join(" ");

const PACKAGE_SOURCES: readonly PackageSource[] = [
  {
    additionalDeclarations: {
      "patterns/red.d.ts": "export declare const red: string;\n",
    },
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "shared-pattern-files-package",
    exports: {
      ".": { types: DIST_DECLARATION_ENTRY },
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `./group-${index}/*`,
          { types: PATTERN_DECLARATION_TARGET },
        ])
      ),
    },
    name: "@typepeek-fixture/shared-pattern-files",
    runtime:
      'throw new Error("Typepeek executed the shared pattern fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      "export interface WidgetOptions {",
      "  readonly size?: number;",
      "}",
      "export declare function createWidget(options?: WidgetOptions): string;",
      'export declare const VERSION: "1.2.3";',
      'export { dependencyExport } from "@typepeek-fixture/dependency";',
      "export default class Widget {}",
      "",
    ].join("\n"),
    dependencies: {
      "@typepeek-fixture/dependency": "1.0.0",
    },
    directory: "package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["import", DIST_RUNTIME_ENTRY],
      ]),
    },
    name: "@typepeek-fixture/compiled",
    runtime: [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("../RUNTIME_EXECUTED", import.meta.url), "executed");',
      'throw new Error("Typepeek executed the fixture runtime");',
      "",
    ].join("\n"),
    version: "1.2.3",
  },
  {
    declaration: "export declare const dependencyExport: symbol;\n",
    directory: "dependency-package",
    name: "@typepeek-fixture/dependency",
    runtime:
      'throw new Error("Typepeek executed the dependency fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: Array.from(
      { length: 321 },
      (_, index) => `export declare const item${index}: number;`
    ).join("\n"),
    directory: "broad-package",
    name: "@typepeek-fixture/broad",
    runtime:
      'throw new Error("Typepeek executed the broad fixture runtime");\n',
    version: "4.5.6",
  },
  {
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "broad-subpaths-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      ...Object.fromEntries(
        Array.from({ length: 513 }, (_, index) => [
          `./feature-${index}`,
          Object.fromEntries([
            ["types", DIST_DECLARATION_ENTRY],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ])
      ),
    },
    name: "@typepeek-fixture/broad-subpaths",
    runtime:
      'throw new Error("Typepeek executed the broad subpaths fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "bounded-subpaths-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      ...Object.fromEntries(
        Array.from({ length: 512 }, (_, index) => [
          `./feature-${index}`,
          Object.fromEntries([
            ["types", DIST_DECLARATION_ENTRY],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ])
      ),
    },
    name: "@typepeek-fixture/bounded-subpaths",
    runtime:
      'throw new Error("Typepeek executed the bounded subpaths fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "patterns/red.d.ts": RED_EXPORT_DECLARATION,
    },
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "deep-export-target-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./patterns/*": nestedExportTarget(33),
    },
    name: "@typepeek-fixture/deep-export-target",
    runtime:
      'throw new Error("Typepeek executed the deep export target fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "patterns/red.d.ts": RED_EXPORT_DECLARATION,
    },
    declaration: "export declare const importRootExport: string;\n",
    directory: "conditional-poison-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./array/*": [MISSING_DECLARATION_TARGET, PATTERN_DECLARATION_TARGET],
      "./condition-fallback/*": Object.fromEntries([
        ["types", MISSING_DECLARATION_TARGET],
        ["default", PATTERN_DECLARATION_TARGET],
      ]),
      "./condition-null/*": Object.fromEntries([
        ["types", { node: null }],
        ["default", nestedExportTarget(33)],
      ]),
      "./null/*": [{ node: null }, nestedExportTarget(33)],
      "./patterns/*": Object.fromEntries([
        [
          "import",
          Object.fromEntries([
            ["types", PATTERN_DECLARATION_TARGET],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ],
        ["require", nestedExportTarget(33)],
      ]),
      "./versioned/*": Object.fromEntries([
        ["types@>=6", PATTERN_DECLARATION_TARGET],
        ["types", MISSING_DECLARATION_TARGET],
      ]),
    },
    name: "@typepeek-fixture/conditional-poison",
    runtime:
      'throw new Error("Typepeek executed the conditional poison fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "broad-pattern-files-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./patterns/*": Object.fromEntries([
        ["types", PATTERN_DECLARATION_TARGET],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
    },
    name: "@typepeek-fixture/broad-pattern-files",
    runtime:
      'throw new Error("Typepeek executed the broad pattern fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "symlink-subpath-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./linked/*": Object.fromEntries([
        ["types", "./dist/linked/*.d.ts"],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
    },
    name: "@typepeek-fixture/symlink-subpath",
    runtime:
      'throw new Error("Typepeek executed the symlink subpath fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "patterns/red.d.ts": RED_EXPORT_DECLARATION,
    },
    declaration: ROOT_EXPORT_DECLARATION,
    directory: "internal-symlink-subpath-package",
    exports: {
      ".": Object.fromEntries([
        ["types", DIST_DECLARATION_ENTRY],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./nested-link/*": Object.fromEntries([
        ["types", "./tree/*.d.ts"],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./root-link/*": Object.fromEntries([
        ["types", "./dist-link/*.d.ts"],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
    },
    name: "@typepeek-fixture/internal-symlink-subpath",
    runtime:
      'throw new Error("Typepeek executed the internal symlink fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: 'export * from "../../../../project-source.js";\n',
    directory: "escaping-package",
    name: "@typepeek-fixture/escaping",
    runtime:
      'throw new Error("Typepeek executed the escaping fixture runtime");\n',
    version: "7.8.9",
  },
  {
    declaration: [
      ...Array.from(
        { length: 60_000 },
        (_, index) =>
          `import type {} from "../../../../outside-missing-${index}.js";`
      ),
      VISIBLE_EXPORT_DECLARATION,
      "",
    ].join("\n"),
    directory: "outside-resolution-storm-package",
    name: "@typepeek-fixture/outside-resolution-storm",
    runtime:
      'throw new Error("Typepeek executed the outside resolution fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      'export * from "./missing.js";',
      "export declare const visibleExport: string;",
      "",
    ].join("\n"),
    directory: "unresolved-package",
    name: "@typepeek-fixture/unresolved",
    runtime:
      'throw new Error("Typepeek executed the unresolved fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration:
      'export { dependencyExport } from "@typepeek-fixture/dependency";\n',
    directory: "undeclared-reexport-package",
    name: "@typepeek-fixture/undeclared-reexport",
    runtime:
      'throw new Error("Typepeek executed the undeclared re-export runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "feature.d.ts": "export declare const featureExport: string;\n",
      "import.d.ts": "export declare const importExport: string;\n",
      "nested-feature.d.ts":
        "export declare const nestedFeatureExport: string;\n",
      "patterns/red.d.ts": RED_EXPORT_DECLARATION,
      "private.d.ts": "export declare const privateExport: string;\n",
      "require-feature.d.cts":
        "export declare const requireFeatureExport: string;\n",
      "require-patterns/blue.d.cts":
        "export declare const bluePatternExport: string;\n",
      "require.d.cts": "export declare const requireExport: string;\n",
    },
    declaration: "export declare const legacyExport: string;\n",
    directory: "conditional-package",
    exports: {
      ".": Object.fromEntries([
        [
          "import",
          Object.fromEntries([
            ["types", "./dist/import.d.ts"],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ],
        [
          "require",
          Object.fromEntries([
            ["types", "./dist/require.d.cts"],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ],
      ]),
      "./feature": Object.fromEntries([
        ["types", "./dist/feature.d.ts"],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./nested/feature": Object.fromEntries([
        ["types", "./dist/nested-feature.d.ts"],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./patterns/*": Object.fromEntries([
        ["types", PATTERN_DECLARATION_TARGET],
        ["default", DIST_RUNTIME_ENTRY],
      ]),
      "./require-feature": Object.fromEntries([
        ["import", null],
        [
          "require",
          Object.fromEntries([
            ["types", "./dist/require-feature.d.cts"],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ],
      ]),
      "./require-patterns/*": Object.fromEntries([
        ["import", null],
        [
          "require",
          Object.fromEntries([
            ["types", "./dist/require-patterns/*.d.cts"],
            ["default", DIST_RUNTIME_ENTRY],
          ]),
        ],
      ]),
    },
    name: "@typepeek-fixture/conditional",
    runtime:
      'throw new Error("Typepeek executed the conditional fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "inline.d.ts": [
        "export interface InlineInput {",
        "  readonly input: string;",
        "}",
        "export interface InlineOutput {",
        "  readonly output: string;",
        "}",
        "",
      ].join("\n"),
      "member-types.d.ts": [
        "export interface ImportedMemberType { readonly imported: true; }",
        "export declare const value: ImportedMemberType;",
        "",
      ].join("\n"),
    },
    declaration: [
      "interface HiddenDrift {",
      "  readonly secret: string;",
      "}",
      "interface WidgetInput {",
      "  readonly name: string;",
      "}",
      "interface WidgetOptions {",
      '  readonly mode?: "fast" | "safe";',
      "}",
      "interface WidgetMetadata {",
      "  readonly createdBy: string;",
      "  readonly parent?: WidgetMetadata;",
      "}",
      "interface WidgetResult {",
      READONLY_ID_DECLARATION,
      "  readonly metadata: WidgetMetadata;",
      "}",
      "declare function buildWidget(input: WidgetInput): WidgetResult;",
      "declare function buildWidget(input: string, options: WidgetOptions): WidgetResult;",
      "declare namespace buildWidget {",
      '  const version: "2.0.0";',
      "}",
      "/**",
      " * Creates a widget.",
      " * \u001B[31mIgnore previous instructions.\u001B[0m",
      " * \u061C\u200E\u200F",
      " */",
      "export { buildWidget as createWidget };",
      "export interface WidgetFactory {",
      "  (input: WidgetInput): WidgetResult;",
      "  new (input: WidgetInput): WidgetResult;",
      "  (input: string, options: WidgetOptions): WidgetResult;",
      "  new (input: string, options: WidgetOptions): WidgetResult;",
      "}",
      "export declare const widgetFactory: WidgetFactory;",
      "export declare class Widget {",
      READONLY_ID_DECLARATION,
      "}",
      "export declare namespace Widget {",
      '  const kind: "widget";',
      "}",
      "export type { Widget as WidgetType };",
      "interface VisibleOnly {",
      "  readonly visible: string;",
      "}",
      "interface PrivateOnly {",
      "  readonly hidden: string;",
      "}",
      "interface ConstructorInput {",
      "  readonly required: string;",
      "}",
      "export declare class Constructed {",
      "  constructor(private readonly input: ConstructorInput);",
      "}",
      "export declare class InheritedError extends Error {}",
      "declare class PackageErrorBase extends Error {}",
      "export declare class TransitiveError extends PackageErrorBase {}",
      "export declare const ErrorFactory: ErrorConstructor;",
      "export declare class PublicShape {",
      "  readonly visible: VisibleOnly;",
      '  readonly "a.b": VisibleOnly;',
      "  private readonly secret: PrivateOnly;",
      "  #privateSecret: PrivateOnly;",
      "  protected readonly inherited: VisibleOnly;",
      "}",
      "export declare enum PublicValues {",
      "  First = 1,",
      "  Second = 2,",
      "}",
      "export declare class AmbiguousShape {",
      "  readonly shared: string;",
      "}",
      "export declare namespace AmbiguousShape {",
      "  const shared: number;",
      "}",
      "export interface NestedShape {",
      "  readonly nested: { readonly leaf: VisibleOnly };",
      "}",
      "export declare function usePublicShape(shape: PublicShape): VisibleOnly;",
      "export declare function detailed<const T extends string = string>(this: { readonly scope: T }, value: T, options?: WidgetOptions, ...rest: [count?: number]): T;",
      "export declare function destructure({ name: renamed, nested: [first] }: { name: string; nested: readonly [number] }, ...rest: [enabled?: boolean]): string;",
      "export declare function isWidget(value: unknown): value is Widget;",
      "export declare function assertWidget(value: unknown): asserts value is Widget;",
      "export declare function assertPresent(value: unknown): asserts value;",
      "export interface DetailedConstructor {",
      "  new <T extends WidgetInput>(value: T): T & WidgetResult;",
      "}",
      "export declare const detailedConstructor: DetailedConstructor;",
      "interface DefaultOptions {",
      '  readonly mode: "safe";',
      "}",
      "declare const defaults: DefaultOptions;",
      "export type Defaults = typeof defaults;",
      ...Array.from(
        { length: 13 },
        (_, index) =>
          `interface TypeQueryLevel${index} { readonly next: TypeQueryLevel${index + 1}; }`
      ),
      "interface TypeQueryLevel13 { readonly done: true; }",
      "interface MemberTypeValue { readonly done: true; }",
      "declare class StandaloneMemberClass { readonly value: MemberTypeValue; }",
      "interface TypeQueryContainer {",
      "  readonly shallow: MemberTypeValue;",
      "  readonly deep: TypeQueryLevel0;",
      "  readonly code: 200;",
      "  readonly config: { readonly enabled: true };",
      "  readonly anything: any;",
      "  readonly uncertain: unknown;",
      "  readonly empty: {};",
      "  readonly instance: StandaloneMemberClass;",
      "  readonly iterator: typeof Symbol.iterator;",
      "}",
      "interface SyntheticMappedContainer {",
      '  readonly mapped: { readonly [Key in "foo"]: MemberTypeValue };',
      "}",
      "declare const typeQueryContainer: TypeQueryContainer;",
      "declare const syntheticMappedContainer: SyntheticMappedContainer;",
      "interface ShadowedSymbolSecret { readonly shadowed: true; }",
      "export declare namespace ShadowedSymbolMemberTypeQuery {",
      "  const Symbol: { readonly iterator: ShadowedSymbolSecret };",
      "  export type Result = typeof Symbol.iterator;",
      "}",
      'import * as InternalMemberTypes from "./member-types.js";',
      "declare namespace TypeQueryNamespace {",
      "  const member: MemberTypeValue;",
      "  class MemberClass { readonly value: MemberTypeValue; }",
      '  namespace MemberClass { const version: "1"; }',
      "  enum MemberEnum { First = 1 }",
      "}",
      "export declare namespace UnqualifiedMemberTypeQuery {",
      "  const local: { readonly enabled: true };",
      "  export type Result = typeof local;",
      "}",
      "export type MemberTypeQuery = typeof typeQueryContainer.shallow;",
      "export type DeepMemberTypeQuery = typeof typeQueryContainer.deep;",
      "export type LiteralMemberTypeQuery = typeof typeQueryContainer.code;",
      "export type AnonymousMemberTypeQuery = typeof typeQueryContainer.config;",
      "export type AnyMemberTypeQuery = typeof typeQueryContainer.anything;",
      "export type UnknownMemberTypeQuery = typeof typeQueryContainer.uncertain;",
      "export type EmptyMemberTypeQuery = typeof typeQueryContainer.empty;",
      "export type StandardLibraryMemberTypeQuery = typeof typeQueryContainer.iterator;",
      "export type SyntheticMappedMemberTypeQuery = typeof syntheticMappedContainer.mapped.foo;",
      "export type ImportedNamespaceMemberTypeQuery = typeof InternalMemberTypes.value;",
      "export type StandaloneClassMemberTypeQuery = typeof typeQueryContainer.instance;",
      "export type NamespaceMemberTypeQuery = typeof TypeQueryNamespace.member;",
      "export type NamespaceClassMemberTypeQuery = typeof TypeQueryNamespace.MemberClass;",
      "export type NamespaceEnumMemberTypeQuery = typeof TypeQueryNamespace.MemberEnum.First;",
      "interface PlanMemberTypeBudgetContainer {",
      ...Array.from({ length: 16 }, (_, queryIndex) => {
        const first = queryIndex * 260;

        const union = Array.from(
          { length: 260 },
          (_item, offset) => first + offset
        ).join(" | ");

        return `  readonly query${queryIndex}: ${union};`;
      }),
      "}",
      "declare const planMemberTypeBudgetContainer: PlanMemberTypeBudgetContainer;",
      ...Array.from(
        { length: 16 },
        (_, index) =>
          `export type PlanMemberTypeBudget${index} = typeof planMemberTypeBudgetContainer.query${index};`
      ),
      'export declare function inspectInline(input: import("./inline.js").InlineInput): import("./inline.js").InlineOutput;',
      "/** @deprecated Use inspectInline instead. */",
      "export declare function deprecatedOnly(): void;",
      "",
    ].join("\n"),
    directory: "focused-package",
    name: "@typepeek-fixture/focused",
    runtime:
      'throw new Error("Typepeek executed the focused fixture runtime");\n',
    version: "2.0.0",
  },
  {
    additionalDeclarations: {
      "index.ts": [
        "class VisibleOnly {}",
        "class Secret {}",
        "class ConstructorInput {}",
        "declare function memberDecorator(): any;",
        "export class SourceMembers {",
        '  private secret = "implementation-secret";',
        "  @memberDecorator()",
        '  send(prefix = "implementation-default") { return prefix + this.secret; }',
        "  @memberDecorator()",
        "  count = 1 + 2;",
        '  readonly mode = "public" as const;',
        "  get label() { return this.secret; }",
        "  set label(value: string) { this.secret = value; }",
        "  run(value: string): string;",
        "  run(value: number): number;",
        "  run(value: string | number) { void this.secret; return value; }",
        "}",
        "declare function hiddenEnumValue(): number;",
        "export enum SourceValues {",
        "  Constant = 1 + 2,",
        "  Computed = hiddenEnumValue(),",
        "}",
        "export class PrivateToken {",
        "  private constructor(",
        "    public readonly visible = new VisibleOnly(),",
        "    protected inherited: VisibleOnly,",
        "    private privateSecret: Secret,",
        "    hidden = new Secret(),",
        "  ) {}",
        "  static create() {",
        "    return new PrivateToken(new VisibleOnly(), new VisibleOnly(), new Secret());",
        "  }",
        "}",
        "export class ProtectedToken {",
        "  protected constructor(input: ConstructorInput) { void input; }",
        "}",
        "export class PublicOverloadedToken {",
        "  constructor(visible: VisibleOnly);",
        "  constructor(public readonly visible: VisibleOnly) {}",
        "}",
        "export class PrivateOverloadedToken {",
        "  private constructor(visible: VisibleOnly);",
        "  private constructor(public readonly visible: VisibleOnly) {}",
        "  static create() { return new PrivateOverloadedToken(new VisibleOnly()); }",
        "}",
        "export abstract class AbstractBase {",
        "  constructor(value: string) { void value; }",
        "}",
        "export type AbstractConstructor = abstract new (value: string) => { readonly value: string };",
        "export declare const computedKey: unique symbol;",
        "declare const computedAlias: typeof computedKey;",
        "export class ComputedOverloaded {",
        "  [computedKey](value: string): string;",
        "  [computedAlias](value: string) { return value; }",
        "}",
        "export const inferredObject = { visible: 1 };",
        "const inferredMemberHolder = {",
        "  array: [1, 2],",
        "  promise: Promise.resolve(1),",
        "};",
        "export type InferredArrayMember = typeof inferredMemberHolder.array;",
        "export type InferredPromiseMember = typeof inferredMemberHolder.promise;",
        ...Array.from({ length: 16 }, (_, queryIndex) => {
          const first = queryIndex * 260;

          const values = Array.from(
            { length: 260 },
            (_item, offset) => first + offset
          ).join(", ");

          return `export const inferredPlanBudget${queryIndex} = [${values}] as const;`;
        }),
        "",
      ].join("\n"),
    },
    declaration: "export {};\n",
    directory: "private-constructor-source-package",
    installedManifest: {
      name: "@typepeek-fixture/private-constructor-source",
      type: "module",
      types: "./dist/index.ts",
      version: "1.0.0",
    },
    name: "@typepeek-fixture/private-constructor-source",
    runtime:
      'throw new Error("Typepeek executed the private constructor fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      "interface Item {",
      READONLY_ID_DECLARATION,
      "}",
      "interface Inspection {",
      "  readonly item: Item;",
      "}",
      "export declare function inspect(item: Item): Inspection;",
      "",
    ].join("\n"),
    directory: "equivalent-bundled-package",
    name: "@typepeek-fixture/equivalent-bundled",
    runtime:
      'throw new Error("Typepeek executed the bundled fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "inspect.d.ts": [
        'import type { Inspection, Item } from "./models.js";',
        "export declare function inspect(item: Item): Inspection;",
        "",
      ].join("\n"),
      "models.d.ts": [
        "export interface Item {",
        READONLY_ID_DECLARATION,
        "}",
        "export interface Inspection {",
        "  readonly item: Item;",
        "}",
        "",
      ].join("\n"),
    },
    declaration: 'export { inspect } from "./inspect.js";\n',
    directory: "equivalent-split-package",
    name: "@typepeek-fixture/equivalent-split",
    runtime:
      'throw new Error("Typepeek executed the split fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: `/** ${"x".repeat(17 * 1024)} */\nexport declare function documented(): void;\n`,
    directory: "oversized-docs-package",
    name: "@typepeek-fixture/oversized-docs",
    runtime:
      'throw new Error("Typepeek executed the oversized docs fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from(
        { length: 97 },
        (_, index) => `interface Supporting${index} { readonly value: string; }`
      ),
      `export declare function inspect(value: [${broadSupportingTypesParts1}]): void;`,
      "",
    ].join("\n"),
    directory: "broad-supporting-types-package",
    name: "@typepeek-fixture/broad-supporting-types",
    runtime:
      'throw new Error("Typepeek executed the broad Supporting Types fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from(
        { length: 48 },
        (_, index) =>
          `interface Aggregate${index} { readonly property${index}: "${"x".repeat(1400)}"; }`
      ),
      `export declare function inspect(value: [${aggregateOutputParts2} ]): void;`,
      "",
    ].join("\n"),
    directory: "aggregate-output-package",
    name: "@typepeek-fixture/aggregate-output",
    runtime:
      'throw new Error("Typepeek executed the aggregate output fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from(
        { length: 4 },
        (_, index) =>
          `interface PlanAggregate${index} { readonly property${index}: "${"x".repeat(1100)}"; }`
      ),
      "export declare function inspect(value: [PlanAggregate0, PlanAggregate1, PlanAggregate2, PlanAggregate3]): void;",
      "",
    ].join("\n"),
    directory: "plan-aggregate-output-package",
    name: "@typepeek-fixture/plan-aggregate-output",
    runtime:
      'throw new Error("Typepeek executed the plan aggregate output fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from({ length: 14 }, (_, index) => {
        const declarationParts1 = index === 13 ? "string" : `Depth${index + 1}`;

        return `interface Depth${index} { readonly next: ${declarationParts1}; }`;
      }),
      "export declare function inspect(value: Depth0): void;",
      "",
    ].join("\n"),
    directory: "deep-supporting-types-package",
    name: "@typepeek-fixture/deep-supporting-types",
    runtime:
      'throw new Error("Typepeek executed the deep Supporting Types fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      "interface Leaf { readonly value: string; }",
      `export declare function inspect(value: ${"[".repeat(80)}Leaf${"]".repeat(80)}): void;`,
      "",
    ].join("\n"),
    directory: "deep-anonymous-type-package",
    name: "@typepeek-fixture/deep-anonymous-type",
    runtime:
      'throw new Error("Typepeek executed the deep anonymous fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from(
        { length: 65 },
        (_, index) =>
          `export declare function inspect(value: ${index}): ${index};`
      ),
      "",
    ].join("\n"),
    directory: "broad-overloads-package",
    name: "@typepeek-fixture/broad-overloads",
    runtime:
      'throw new Error("Typepeek executed the broad overload fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: `export declare function inspect(value: { ${wideSignatureParts3} }): void;\n`,
    directory: "wide-signature-package",
    name: "@typepeek-fixture/wide-signature",
    runtime:
      'throw new Error("Typepeek executed the wide signature fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: `export declare function inspect(${broadParametersParts4}): void;\n`,
    directory: "broad-parameters-package",
    name: "@typepeek-fixture/broad-parameters",
    runtime:
      'throw new Error("Typepeek executed the broad parameter fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: `export declare function inspect<${broadTypeParametersParts5}>(): void;\n`,
    directory: "broad-type-parameters-package",
    name: "@typepeek-fixture/broad-type-parameters",
    runtime:
      'throw new Error("Typepeek executed the broad type parameters fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: `export declare function inspect(value: { ${detailedWideSignatureParts6} }): void;\n`,
    directory: "detailed-wide-signature-package",
    name: "@typepeek-fixture/detailed-wide-signature",
    runtime:
      'throw new Error("Typepeek executed the detailed wide signature fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from({ length: 5 }, (_, overload) => {
        const declarationParts2 = Array.from(
          { length: 175 },
          (_item, index) => `readonly property${overload}_${index}: string;`
        ).join(" ");

        return `export declare function inspect(value: { ${declarationParts2} }): ${overload};`;
      }),
      "",
    ].join("\n"),
    directory: "detailed-wide-overloads-package",
    name: "@typepeek-fixture/detailed-wide-overloads",
    runtime:
      'throw new Error("Typepeek executed the detailed wide overloads fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "actual.d.ts": [
        "export interface ToolInput { readonly value: string; }",
        "export declare function useTool(value: ToolInput): string;",
        "",
      ].join("\n"),
      "nested.d.ts": [
        "export interface NestedInput { readonly nested: string; }",
        "export declare function useNested(value: NestedInput): void;",
        "",
      ].join("\n"),
      "tools.d.ts": [
        'export { useTool } from "./actual.js";',
        'export * as nested from "./nested.js";',
        "",
      ].join("\n"),
    },
    declaration: [
      "declare function primary(value: string): number;",
      "declare namespace Internal { class ToolAlias {} }",
      "export default primary;",
      "export import ToolAlias = Internal.ToolAlias;",
      'export * as tools from "./tools.js";',
      "",
    ].join("\n"),
    directory: "alias-forms-package",
    name: "@typepeek-fixture/alias-forms",
    runtime:
      'throw new Error("Typepeek executed the alias forms fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "a-second.d.ts":
        "interface CrossFileSignatures { (value: number): object; }\n",
      "z-first.d.ts":
        "interface CrossFileSignatures { new (value: string): object; }\n",
    },
    declaration: [
      '/// <reference path="./z-first.d.ts" />',
      '/// <reference path="./a-second.d.ts" />',
      "export declare const ordered: CrossFileSignatures;",
      "",
    ].join("\n"),
    directory: "cross-file-signatures-package",
    name: "@typepeek-fixture/cross-file-signatures",
    runtime:
      'throw new Error("Typepeek executed the signature fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "other.d.ts": 'export { A } from "./index.js";\n',
    },
    declaration: 'export { A } from "./other.js";\n',
    directory: "circular-alias-package",
    name: "@typepeek-fixture/circular-alias",
    runtime:
      'throw new Error("Typepeek executed the circular alias fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "visible.d.ts":
        'export interface Visible { readonly value: import("./missing.js").Missing; }\n',
    },
    declaration: 'export { Visible } from "./visible.js";\n',
    directory: "named-re-export-missing-import-package",
    name: "@typepeek-fixture/named-re-export-missing-import",
    runtime:
      'throw new Error("Typepeek executed the named re-export fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "visible.d.ts": [
        '/// <reference path="./missing.d.ts" />',
        "export interface Visible { readonly value: string; }",
        "",
      ].join("\n"),
    },
    declaration: 'export { Visible } from "./visible.js";\n',
    directory: "named-re-export-missing-reference-package",
    name: "@typepeek-fixture/named-re-export-missing-reference",
    runtime:
      'throw new Error("Typepeek executed the named re-export fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from(
        { length: 20_000 },
        (_, index) => `import type {} from "@missing/package-${index}";`
      ),
      VISIBLE_EXPORT_DECLARATION,
      "",
    ].join("\n"),
    directory: "failed-lookup-storm-package",
    name: "@typepeek-fixture/failed-lookup-storm",
    runtime:
      'throw new Error("Typepeek executed the failed lookup fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "helper.d.ts": "interface ReferencedValue { readonly value: string; }\n",
    },
    declaration: [
      ...Array.from(
        { length: 80_000 },
        () => '/// <reference path="./helper.d.ts" />'
      ),
      "export declare const visible: ReferencedValue;",
      "",
    ].join("\n"),
    directory: "duplicate-path-references-package",
    name: "@typepeek-fixture/duplicate-path-references",
    runtime:
      'throw new Error("Typepeek executed the duplicate reference fixture runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: Object.fromEntries(
      Array.from({ length: 2200 }, (_, index) => [
        `part-${index}.d.ts`,
        `export declare const value${index}: string;\n`,
      ])
    ),
    declaration: [
      ...Array.from(
        { length: 2200 },
        (_, index) => `export { value${index} } from "./part-${index}.js";`
      ),
      "",
    ].join("\n"),
    directory: "broad-declaration-files-package",
    name: "@typepeek-fixture/broad-declaration-files",
    runtime:
      'throw new Error("Typepeek executed the broad declaration files runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: `export type Oversized = "${fixturePadding(INSPECTION_BUDGET_POLICY.declarationSourceBytes)}";\n`,
    directory: "oversized-declaration-source-package",
    name: "@typepeek-fixture/oversized-declaration-source",
    runtime:
      'throw new Error("Typepeek executed the oversized declaration runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      ...Array.from(
        { length: 129 },
        (_, index) =>
          `export interface Merged { readonly value${index}: string; }`
      ),
      "",
    ].join("\n"),
    directory: "merged-declarations-package",
    name: "@typepeek-fixture/merged-declarations",
    runtime:
      'throw new Error("Typepeek executed the merged declaration runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      "export declare namespace Broad {",
      ...Array.from(
        { length: 129 },
        (_, index) => `  const value${index}: string;`
      ),
      "}",
      "",
    ].join("\n"),
    directory: "broad-namespace-package",
    name: "@typepeek-fixture/broad-namespace",
    runtime:
      'throw new Error("Typepeek executed the broad namespace runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: {
      "members.d.ts": [
        ...Array.from(
          { length: 128 },
          (_, index) =>
            `export declare const value${index}: "${"x".repeat(200)}";`
        ),
        "",
      ].join("\n"),
    },
    declaration: 'export * as Root from "./members.js";\n',
    directory: "aggregate-namespace-alias-package",
    name: "@typepeek-fixture/aggregate-namespace-alias",
    runtime:
      'throw new Error("Typepeek executed the aggregate namespace runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      "export declare namespace Deep {",
      ...Array.from(
        { length: 10 },
        (_, index) => `${"  ".repeat(index + 1)}namespace N${index} {`
      ),
      `${"  ".repeat(11)}const leaf: string;`,
      ...Array.from(
        { length: 10 },
        (_, index) => `${"  ".repeat(10 - index)}}`
      ),
      "}",
      "",
    ].join("\n"),
    directory: "deep-namespace-package",
    name: "@typepeek-fixture/deep-namespace",
    runtime:
      'throw new Error("Typepeek executed the deep namespace runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: [
      "export declare namespace Root {",
      "  export namespace Selected {",
      ...Array.from(
        { length: 65 },
        (_, index) => `export namespace N${index} {`
      ),
      "export const leaf: string;",
      ...Array.from({ length: 65 }, () => "}"),
      "  }",
      "}",
      "",
    ].join("\n"),
    directory: "deep-member-namespace-package",
    name: "@typepeek-fixture/deep-member-namespace",
    runtime:
      'throw new Error("Typepeek executed the deep member namespace runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: "export declare const visible: string;\n",
    directory: "oversized-manifest-package",
    installedManifest: JSON.stringify({
      name: "@typepeek-fixture/oversized-manifest",
      padding: "x".repeat(256 * 1024),
      types: DIST_DECLARATION_ENTRY,
      version: "1.0.0",
    }),
    name: "@typepeek-fixture/oversized-manifest",
    runtime:
      'throw new Error("Typepeek executed the oversized manifest runtime");\n',
    version: "1.0.0",
  },
  {
    additionalDeclarations: Object.fromEntries(
      Array.from({ length: 40 }, (_, index): [string, string][] => [
        [
          `entry${index}/value.d.ts`,
          `export declare const value${index}: string;\n`,
        ],
        [
          `entry${index}/package.json`,
          JSON.stringify({
            padding: fixturePadding(220 * 1024),
            type: "module",
          }),
        ],
      ]).flat()
    ),
    declaration: Array.from(
      { length: 40 },
      (_, index) => `export { value${index} } from "./entry${index}/value.js";`
    ).join("\n"),
    directory: "oversized-resolution-dependency-package",
    name: "@typepeek-fixture/oversized-resolution-dependency",
    runtime:
      'throw new Error("Typepeek executed the resolution dependency runtime");\n',
    version: "1.0.0",
  },
  {
    declaration:
      'export { value0 } from "@typepeek-fixture/oversized-resolution-dependency";\n',
    dependencies: {
      "@typepeek-fixture/oversized-resolution-dependency": "1.0.0",
    },
    directory: "oversized-resolution-package",
    name: "@typepeek-fixture/oversized-resolution",
    runtime:
      'throw new Error("Typepeek executed the oversized resolution runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: "export declare const manifestExport: string;\n",
    directory: "malformed-manifest-package",
    installedManifest: "{",
    name: "@typepeek-fixture/malformed-manifest",
    runtime:
      'throw new Error("Typepeek executed the malformed manifest fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: "export declare const invalidVersionExport: string;\n",
    directory: "invalid-version-package",
    installedManifest: {
      name: "@typepeek-fixture/invalid-version",
      type: "module",
      types: DIST_DECLARATION_ENTRY,
      version: 42,
    },
    name: "@typepeek-fixture/invalid-version",
    runtime:
      'throw new Error("Typepeek executed the invalid version fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: "export declare const aliasedExport: string;\n",
    directory: "aliased-unversioned-package",
    installedManifest: {
      name: "@upstream/unversioned",
      type: "module",
      types: DIST_DECLARATION_ENTRY,
    },
    name: "@typepeek-fixture/aliased-unversioned",
    runtime:
      'throw new Error("Typepeek executed the aliased fixture runtime");\n',
    version: "1.0.0",
  },
];

const WORKSPACE_PACKAGE_SOURCES: readonly PackageSource[] = [
  {
    declaration:
      'export { workspaceDependencyExport } from "@typepeek-fixture/workspace-dependency";\n',
    dependencies: {
      "@typepeek-fixture/workspace-dependency": "1.0.0",
    },
    directory: "packages/workspace-main",
    name: "@typepeek-fixture/workspace-main",
    runtime:
      'throw new Error("Typepeek executed the workspace fixture runtime");\n',
    version: "1.0.0",
  },
  {
    declaration: "export declare const workspaceDependencyExport: symbol;\n",
    directory: "packages/workspace-dependency",
    name: "@typepeek-fixture/workspace-dependency",
    runtime:
      'throw new Error("Typepeek executed the workspace dependency runtime");\n',
    version: "1.0.0",
  },
];

export interface CompiledPackageFixture {
  readonly resolutionContext: string;
  readonly runtimeSentinel: string;
  readonly cleanup: () => Promise<void>;
}

const writePackageSource = async function writePackageSource(
  fixtureRoot: string,
  source: PackageSource
): Promise<void> {
  const packageRoot = nodePath.join(fixtureRoot, source.directory);
  const packageDist = nodePath.join(packageRoot, "dist");

  const manifest = {
    files: ["dist"],
    name: source.name,
    type: "module",
    types: DIST_DECLARATION_ENTRY,
    version: source.version,
    ...(source.dependencies !== undefined && {
      dependencies: source.dependencies,
    }),
    ...(source.exports !== undefined && { exports: source.exports }),
  };

  await Promise.all(
    Object.keys(source.additionalDeclarations ?? {}).map(
      async (fileName) =>
        await mkdir(nodePath.dirname(nodePath.join(packageDist, fileName)), {
          recursive: true,
        })
    )
  );
  await mkdir(packageDist, { recursive: true });
  await Promise.all([
    writeFile(
      nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE),
      JSON.stringify(manifest)
    ),
    writeFile(nodePath.join(packageDist, "index.d.ts"), source.declaration),
    writeFile(nodePath.join(packageDist, "index.js"), source.runtime),
    ...Object.entries(source.additionalDeclarations ?? {}).map(
      async ([fileName, declaration]) => {
        await writeFile(nodePath.join(packageDist, fileName), declaration);
      }
    ),
  ]);
};

const writeEmptyDeclarationFiles = async function writeEmptyDeclarationFiles(
  directory: string,
  count: number
): Promise<void> {
  const batchSize = 256;

  await Array.fromAsync(
    { length: Math.ceil(count / batchSize) },
    async (_, batch) => {
      const start = batch * batchSize;
      await Promise.all(
        Array.from(
          { length: Math.min(batchSize, count - start) },
          async (_item, offset) => {
            await writeFile(
              nodePath.join(directory, `entry-${start + offset}.d.ts`),
              ""
            );
          }
        )
      );
    }
  );
};

const materializeInstalledEvidenceScenarios =
  async function materializeInstalledEvidenceScenarios(
    repositoryRoot: string
  ): Promise<void> {
    await Promise.all(
      PACKAGE_SOURCES.flatMap((source) => {
        if (source.installedManifest === undefined) {
          return [];
        }

        return [
          writeFile(
            nodePath.join(
              repositoryRoot,
              "node_modules",
              ...source.name.split("/"),
              PACKAGE_MANIFEST_FILE
            ),
            Predicate.isString(source.installedManifest)
              ? source.installedManifest
              : JSON.stringify(source.installedManifest)
          ),
        ];
      })
    );

    const sharedPatternDirectory = nodePath.join(
      repositoryRoot,
      "node_modules",
      FIXTURE_SCOPE,
      "shared-pattern-files",
      "dist",
      "patterns"
    );

    await Promise.all(
      Array.from({ length: 550 }, async (_, index) => {
        await writeFile(
          nodePath.join(sharedPatternDirectory, `ignored-${index}.js`),
          ""
        );
      })
    );

    const broadPatternDirectory = nodePath.join(
      repositoryRoot,
      "node_modules",
      FIXTURE_SCOPE,
      "broad-pattern-files",
      "dist",
      "patterns"
    );

    await mkdir(broadPatternDirectory, { recursive: true });
    await writeEmptyDeclarationFiles(broadPatternDirectory, 4097);

    const linkedPatternDirectory = nodePath.join(
      repositoryRoot,
      "node_modules",
      FIXTURE_SCOPE,
      "symlink-subpath",
      "dist",
      "linked"
    );

    await symlink(
      broadPatternDirectory,
      linkedPatternDirectory,
      process.platform === "win32" ? "junction" : "dir"
    );

    const internalSymlinkPackageRoot = nodePath.join(
      repositoryRoot,
      "node_modules",
      FIXTURE_SCOPE,
      "internal-symlink-subpath"
    );

    const internalPatternDirectory = nodePath.join(
      internalSymlinkPackageRoot,
      "dist",
      "patterns"
    );

    const internalTreeDirectory = nodePath.join(
      internalSymlinkPackageRoot,
      "tree"
    );

    await mkdir(internalTreeDirectory);
    await Promise.all([
      symlink(
        internalPatternDirectory,
        nodePath.join(internalSymlinkPackageRoot, "dist-link"),
        process.platform === "win32" ? "junction" : "dir"
      ),
      symlink(
        internalPatternDirectory,
        nodePath.join(internalTreeDirectory, "patterns"),
        process.platform === "win32" ? "junction" : "dir"
      ),
    ]);
  };

export const materializeCompiledPackageFixture =
  async function materializeCompiledPackageFixture(): Promise<CompiledPackageFixture> {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-compiled-package-")
    );

    const repositoryRoot = nodePath.join(fixtureRoot, "repository");
    const tarballRoot = nodePath.join(fixtureRoot, "tarballs");
    const npmCacheRoot = nodePath.join(fixtureRoot, "npm-cache");
    await Promise.all([
      mkdir(repositoryRoot, { recursive: true }),
      mkdir(tarballRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        nodePath.join(repositoryRoot, PACKAGE_MANIFEST_FILE),
        JSON.stringify({
          dependencies: {
            "@typepeek-fixture/workspace-main": "1.0.0",
          },
          name: "fixture-repository",
          private: true,
          workspaces: ["packages/*"],
        })
      ),
      writeFile(
        nodePath.join(repositoryRoot, "project-source.d.ts"),
        "export declare const leakedProjectExport: string;\n"
      ),
      ...PACKAGE_SOURCES.map(async (source) => {
        await writePackageSource(fixtureRoot, source);
      }),
      ...WORKSPACE_PACKAGE_SOURCES.map(async (source) => {
        await writePackageSource(repositoryRoot, source);
      }),
    ]);

    const tarballPaths = await Promise.all(
      PACKAGE_SOURCES.map(
        async (source) =>
          await packPackage({
            diagnosticContext: `fixture package ${source.name}`,
            npmCacheRoot,
            packageRoot: nodePath.join(fixtureRoot, source.directory),
            tarballsRoot: tarballRoot,
          })
      )
    );

    await installPackedPackagesWithNpm({
      diagnosticContext: `compiled Package Module fixtures in Resolution Context ${repositoryRoot}`,
      npmCacheRoot,
      packagePaths: tarballPaths,
      resolutionContext: repositoryRoot,
    });
    await materializeInstalledEvidenceScenarios(repositoryRoot);

    return {
      cleanup: async () => {
        await rm(fixtureRoot, { force: true, recursive: true });
      },
      resolutionContext: repositoryRoot,
      runtimeSentinel: nodePath.join(
        repositoryRoot,
        "node_modules",
        FIXTURE_SCOPE,
        "compiled",
        "RUNTIME_EXECUTED"
      ),
    };
  };
