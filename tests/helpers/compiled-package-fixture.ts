import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { installPackedPackagesWithNpm, packPackage } from "./package-toolchain.ts";

interface PackageSource {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly declaration: string;
  readonly additionalDeclarations?: Readonly<Record<string, string>>;
  readonly installedManifest?: string | Readonly<Record<string, unknown>>;
  readonly runtime: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: object;
}

function nestedExportTarget(depth: number): object {
  let target: object = { types: "./dist/patterns/*.d.ts" };
  for (let index = 0; index < depth; index += 1) {
    target = { node: target };
  }
  return target;
}

const PACKAGE_SOURCES: readonly PackageSource[] = [
  {
    directory: "package",
    name: "@typepeek-fixture/compiled",
    version: "1.2.3",
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
    runtime: [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("../RUNTIME_EXECUTED", import.meta.url), "executed");',
      'throw new Error("Typepeek executed the fixture runtime");',
      "",
    ].join("\n"),
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
  },
  {
    directory: "dependency-package",
    name: "@typepeek-fixture/dependency",
    version: "1.0.0",
    declaration: "export declare const dependencyExport: symbol;\n",
    runtime: 'throw new Error("Typepeek executed the dependency fixture runtime");\n',
  },
  {
    directory: "broad-package",
    name: "@typepeek-fixture/broad",
    version: "4.5.6",
    declaration: Array.from(
      { length: 201 },
      (_, index) => `export declare const item${index}: number;`,
    ).join("\n"),
    runtime: 'throw new Error("Typepeek executed the broad fixture runtime");\n',
  },
  {
    directory: "broad-subpaths-package",
    name: "@typepeek-fixture/broad-subpaths",
    version: "1.0.0",
    declaration: "export declare const rootExport: string;\n",
    runtime: 'throw new Error("Typepeek executed the broad subpaths fixture runtime");\n',
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      ...Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [
          `./feature-${index}`,
          {
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
        ]),
      ),
    },
  },
  {
    directory: "deep-export-target-package",
    name: "@typepeek-fixture/deep-export-target",
    version: "1.0.0",
    declaration: "export declare const rootExport: string;\n",
    additionalDeclarations: {
      "patterns/red.d.ts": "export declare const redPatternExport: string;\n",
    },
    runtime: 'throw new Error("Typepeek executed the deep export target fixture runtime");\n',
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./patterns/*": nestedExportTarget(33),
    },
  },
  {
    directory: "conditional-poison-package",
    name: "@typepeek-fixture/conditional-poison",
    version: "1.0.0",
    declaration: "export declare const importRootExport: string;\n",
    additionalDeclarations: {
      "patterns/red.d.ts": "export declare const redPatternExport: string;\n",
    },
    runtime: 'throw new Error("Typepeek executed the conditional poison fixture runtime");\n',
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./patterns/*": {
        import: {
          types: "./dist/patterns/*.d.ts",
          default: "./dist/index.js",
        },
        require: nestedExportTarget(33),
      },
      "./array/*": ["./dist/missing/*.d.ts", "./dist/patterns/*.d.ts"],
      "./condition-fallback/*": {
        types: "./dist/missing/*.d.ts",
        default: "./dist/patterns/*.d.ts",
      },
      "./condition-null/*": {
        types: { node: null },
        default: nestedExportTarget(33),
      },
      "./null/*": [{ node: null }, nestedExportTarget(33)],
      "./versioned/*": {
        "types@>=6": "./dist/patterns/*.d.ts",
        types: "./dist/missing/*.d.ts",
      },
    },
  },
  {
    directory: "broad-pattern-files-package",
    name: "@typepeek-fixture/broad-pattern-files",
    version: "1.0.0",
    declaration: "export declare const rootExport: string;\n",
    runtime: 'throw new Error("Typepeek executed the broad pattern fixture runtime");\n',
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./patterns/*": {
        types: "./dist/patterns/*.d.ts",
        default: "./dist/index.js",
      },
    },
  },
  {
    directory: "symlink-subpath-package",
    name: "@typepeek-fixture/symlink-subpath",
    version: "1.0.0",
    declaration: "export declare const rootExport: string;\n",
    runtime: 'throw new Error("Typepeek executed the symlink subpath fixture runtime");\n',
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./linked/*": {
        types: "./dist/linked/*.d.ts",
        default: "./dist/index.js",
      },
    },
  },
  {
    directory: "internal-symlink-subpath-package",
    name: "@typepeek-fixture/internal-symlink-subpath",
    version: "1.0.0",
    declaration: "export declare const rootExport: string;\n",
    additionalDeclarations: {
      "patterns/red.d.ts": "export declare const redPatternExport: string;\n",
    },
    runtime: 'throw new Error("Typepeek executed the internal symlink fixture runtime");\n',
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./nested-link/*": {
        types: "./tree/*.d.ts",
        default: "./dist/index.js",
      },
      "./root-link/*": {
        types: "./dist-link/*.d.ts",
        default: "./dist/index.js",
      },
    },
  },
  {
    directory: "escaping-package",
    name: "@typepeek-fixture/escaping",
    version: "7.8.9",
    declaration: 'export * from "../../../../project-source.js";\n',
    runtime: 'throw new Error("Typepeek executed the escaping fixture runtime");\n',
  },
  {
    directory: "unresolved-package",
    name: "@typepeek-fixture/unresolved",
    version: "1.0.0",
    declaration: [
      'export * from "./missing.js";',
      "export declare const visibleExport: string;",
      "",
    ].join("\n"),
    runtime: 'throw new Error("Typepeek executed the unresolved fixture runtime");\n',
  },
  {
    directory: "conditional-package",
    name: "@typepeek-fixture/conditional",
    version: "1.0.0",
    declaration: "export declare const legacyExport: string;\n",
    additionalDeclarations: {
      "feature.d.ts": "export declare const featureExport: string;\n",
      "nested-feature.d.ts": "export declare const nestedFeatureExport: string;\n",
      "patterns/red.d.ts": "export declare const redPatternExport: string;\n",
      "private.d.ts": "export declare const privateExport: string;\n",
      "import.d.ts": "export declare const importExport: string;\n",
      "require-feature.d.cts": "export declare const requireFeatureExport: string;\n",
      "require-patterns/blue.d.cts": "export declare const bluePatternExport: string;\n",
      "require.d.cts": "export declare const requireExport: string;\n",
    },
    runtime: 'throw new Error("Typepeek executed the conditional fixture runtime");\n',
    exports: {
      ".": {
        import: {
          types: "./dist/import.d.ts",
          default: "./dist/index.js",
        },
        require: {
          types: "./dist/require.d.cts",
          default: "./dist/index.js",
        },
      },
      "./feature": {
        types: "./dist/feature.d.ts",
        default: "./dist/index.js",
      },
      "./nested/feature": {
        types: "./dist/nested-feature.d.ts",
        default: "./dist/index.js",
      },
      "./patterns/*": {
        types: "./dist/patterns/*.d.ts",
        default: "./dist/index.js",
      },
      "./require-feature": {
        import: null,
        require: {
          types: "./dist/require-feature.d.cts",
          default: "./dist/index.js",
        },
      },
      "./require-patterns/*": {
        import: null,
        require: {
          types: "./dist/require-patterns/*.d.cts",
          default: "./dist/index.js",
        },
      },
    },
  },
  {
    directory: "focused-package",
    name: "@typepeek-fixture/focused",
    version: "2.0.0",
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
      "  readonly id: string;",
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
      "  readonly id: string;",
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
      "export declare class PublicShape {",
      "  readonly visible: VisibleOnly;",
      "  private readonly secret: PrivateOnly;",
      "  #privateSecret: PrivateOnly;",
      "  protected readonly inherited: VisibleOnly;",
      "}",
      "export declare function usePublicShape(shape: PublicShape): VisibleOnly;",
      "interface DefaultOptions {",
      '  readonly mode: "safe";',
      "}",
      "declare const defaults: DefaultOptions;",
      "export type Defaults = typeof defaults;",
      'export declare function inspectInline(input: import("./inline.js").InlineInput): import("./inline.js").InlineOutput;',
      "/** @deprecated Use inspectInline instead. */",
      "export declare function deprecatedOnly(): void;",
      "",
    ].join("\n"),
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
    },
    runtime: 'throw new Error("Typepeek executed the focused fixture runtime");\n',
  },
  {
    directory: "equivalent-bundled-package",
    name: "@typepeek-fixture/equivalent-bundled",
    version: "1.0.0",
    declaration: [
      "interface Item {",
      "  readonly id: string;",
      "}",
      "interface Inspection {",
      "  readonly item: Item;",
      "}",
      "export declare function inspect(item: Item): Inspection;",
      "",
    ].join("\n"),
    runtime: 'throw new Error("Typepeek executed the bundled fixture runtime");\n',
  },
  {
    directory: "equivalent-split-package",
    name: "@typepeek-fixture/equivalent-split",
    version: "1.0.0",
    declaration: 'export { inspect } from "./inspect.js";\n',
    additionalDeclarations: {
      "inspect.d.ts": [
        'import type { Inspection, Item } from "./models.js";',
        "export declare function inspect(item: Item): Inspection;",
        "",
      ].join("\n"),
      "models.d.ts": [
        "export interface Item {",
        "  readonly id: string;",
        "}",
        "export interface Inspection {",
        "  readonly item: Item;",
        "}",
        "",
      ].join("\n"),
    },
    runtime: 'throw new Error("Typepeek executed the split fixture runtime");\n',
  },
  {
    directory: "oversized-docs-package",
    name: "@typepeek-fixture/oversized-docs",
    version: "1.0.0",
    declaration: `/** ${"x".repeat(17 * 1_024)} */\nexport declare function documented(): void;\n`,
    runtime: 'throw new Error("Typepeek executed the oversized docs fixture runtime");\n',
  },
  {
    directory: "broad-supporting-types-package",
    name: "@typepeek-fixture/broad-supporting-types",
    version: "1.0.0",
    declaration: [
      ...Array.from(
        { length: 49 },
        (_, index) => `interface Supporting${index} { readonly value: string; }`,
      ),
      `export declare function inspect(value: [${Array.from(
        { length: 49 },
        (_, index) => `Supporting${index}`,
      ).join(", ")}]): void;`,
      "",
    ].join("\n"),
    runtime: 'throw new Error("Typepeek executed the broad Supporting Types fixture runtime");\n',
  },
  {
    directory: "deep-supporting-types-package",
    name: "@typepeek-fixture/deep-supporting-types",
    version: "1.0.0",
    declaration: [
      ...Array.from(
        { length: 10 },
        (_, index) =>
          `interface Depth${index} { readonly next: ${index === 9 ? "string" : `Depth${index + 1}`}; }`,
      ),
      "export declare function inspect(value: Depth0): void;",
      "",
    ].join("\n"),
    runtime: 'throw new Error("Typepeek executed the deep Supporting Types fixture runtime");\n',
  },
  {
    directory: "broad-overloads-package",
    name: "@typepeek-fixture/broad-overloads",
    version: "1.0.0",
    declaration: [
      ...Array.from(
        { length: 65 },
        (_, index) => `export declare function inspect(value: ${index}): ${index};`,
      ),
      "",
    ].join("\n"),
    runtime: 'throw new Error("Typepeek executed the broad overload fixture runtime");\n',
  },
  {
    directory: "wide-signature-package",
    name: "@typepeek-fixture/wide-signature",
    version: "1.0.0",
    declaration: `export declare function inspect(value: { ${Array.from(
      { length: 1_200 },
      (_, index) => `readonly property${index}: string;`,
    ).join(" ")} }): void;\n`,
    runtime: 'throw new Error("Typepeek executed the wide signature fixture runtime");\n',
  },
  {
    directory: "alias-forms-package",
    name: "@typepeek-fixture/alias-forms",
    version: "1.0.0",
    declaration: [
      "declare function primary(value: string): number;",
      "declare namespace Internal { class ToolAlias {} }",
      "export default primary;",
      "export import ToolAlias = Internal.ToolAlias;",
      'export * as tools from "./tools.js";',
      "",
    ].join("\n"),
    additionalDeclarations: {
      "tools.d.ts": [
        'export { useTool } from "./actual.js";',
        'export * as nested from "./nested.js";',
        "",
      ].join("\n"),
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
    },
    runtime: 'throw new Error("Typepeek executed the alias forms fixture runtime");\n',
  },
  {
    directory: "cross-file-signatures-package",
    name: "@typepeek-fixture/cross-file-signatures",
    version: "1.0.0",
    declaration: [
      '/// <reference path="./z-first.d.ts" />',
      '/// <reference path="./a-second.d.ts" />',
      "export declare const ordered: CrossFileSignatures;",
      "",
    ].join("\n"),
    additionalDeclarations: {
      "z-first.d.ts": "interface CrossFileSignatures { new (value: string): object; }\n",
      "a-second.d.ts": "interface CrossFileSignatures { (value: number): object; }\n",
    },
    runtime: 'throw new Error("Typepeek executed the signature fixture runtime");\n',
  },
  {
    directory: "circular-alias-package",
    name: "@typepeek-fixture/circular-alias",
    version: "1.0.0",
    declaration: 'export { A } from "./other.js";\n',
    additionalDeclarations: {
      "other.d.ts": 'export { A } from "./index.js";\n',
    },
    runtime: 'throw new Error("Typepeek executed the circular alias fixture runtime");\n',
  },
  {
    directory: "malformed-manifest-package",
    name: "@typepeek-fixture/malformed-manifest",
    version: "1.0.0",
    declaration: "export declare const manifestExport: string;\n",
    installedManifest: "{",
    runtime: 'throw new Error("Typepeek executed the malformed manifest fixture runtime");\n',
  },
  {
    directory: "invalid-version-package",
    name: "@typepeek-fixture/invalid-version",
    version: "1.0.0",
    declaration: "export declare const invalidVersionExport: string;\n",
    installedManifest: {
      name: "@typepeek-fixture/invalid-version",
      version: 42,
      type: "module",
      types: "./dist/index.d.ts",
    },
    runtime: 'throw new Error("Typepeek executed the invalid version fixture runtime");\n',
  },
  {
    directory: "aliased-unversioned-package",
    name: "@typepeek-fixture/aliased-unversioned",
    version: "1.0.0",
    declaration: "export declare const aliasedExport: string;\n",
    installedManifest: {
      name: "@upstream/unversioned",
      type: "module",
      types: "./dist/index.d.ts",
    },
    runtime: 'throw new Error("Typepeek executed the aliased fixture runtime");\n',
  },
];

const WORKSPACE_PACKAGE_SOURCES: readonly PackageSource[] = [
  {
    directory: "packages/workspace-main",
    name: "@typepeek-fixture/workspace-main",
    version: "1.0.0",
    declaration:
      'export { workspaceDependencyExport } from "@typepeek-fixture/workspace-dependency";\n',
    runtime: 'throw new Error("Typepeek executed the workspace fixture runtime");\n',
    dependencies: {
      "@typepeek-fixture/workspace-dependency": "1.0.0",
    },
  },
  {
    directory: "packages/workspace-dependency",
    name: "@typepeek-fixture/workspace-dependency",
    version: "1.0.0",
    declaration: "export declare const workspaceDependencyExport: symbol;\n",
    runtime: 'throw new Error("Typepeek executed the workspace dependency runtime");\n',
  },
];

export interface CompiledPackageFixture {
  readonly resolutionContext: string;
  readonly runtimeSentinel: string;
  readonly cleanup: () => Promise<void>;
}

export async function materializeCompiledPackageFixture(): Promise<CompiledPackageFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-compiled-package-"));
  const repositoryRoot = join(fixtureRoot, "repository");
  const tarballRoot = join(fixtureRoot, "tarballs");
  const npmCacheRoot = join(fixtureRoot, "npm-cache");

  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(repositoryRoot, "package.json"),
      JSON.stringify({
        name: "fixture-repository",
        private: true,
        workspaces: ["packages/*"],
      }),
    ),
    writeFile(
      join(repositoryRoot, "project-source.d.ts"),
      "export declare const leakedProjectExport: string;\n",
    ),
    ...PACKAGE_SOURCES.map((source) => writePackageSource(fixtureRoot, source)),
    ...WORKSPACE_PACKAGE_SOURCES.map((source) => writePackageSource(repositoryRoot, source)),
  ]);

  const tarballPaths = await Promise.all(
    PACKAGE_SOURCES.map((source) =>
      packPackage({
        diagnosticContext: `fixture package ${source.name}`,
        npmCacheRoot,
        packageRoot: join(fixtureRoot, source.directory),
        tarballsRoot: tarballRoot,
      }),
    ),
  );
  await installPackedPackagesWithNpm({
    diagnosticContext: `compiled Package Module fixtures in Resolution Context ${repositoryRoot}`,
    npmCacheRoot,
    packagePaths: tarballPaths,
    resolutionContext: repositoryRoot,
  });
  await materializeInstalledEvidenceScenarios(repositoryRoot);

  return {
    resolutionContext: repositoryRoot,
    runtimeSentinel: join(
      repositoryRoot,
      "node_modules",
      "@typepeek-fixture",
      "compiled",
      "RUNTIME_EXECUTED",
    ),
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
}

async function materializeInstalledEvidenceScenarios(repositoryRoot: string): Promise<void> {
  await Promise.all(
    PACKAGE_SOURCES.flatMap((source) =>
      source.installedManifest === undefined
        ? []
        : [
            writeFile(
              join(repositoryRoot, "node_modules", ...source.name.split("/"), "package.json"),
              typeof source.installedManifest === "string"
                ? source.installedManifest
                : JSON.stringify(source.installedManifest),
            ),
          ],
    ),
  );

  const broadPatternDirectory = join(
    repositoryRoot,
    "node_modules",
    "@typepeek-fixture",
    "broad-pattern-files",
    "dist",
    "patterns",
  );
  await mkdir(broadPatternDirectory, { recursive: true });
  await writeEmptyDeclarationFiles(broadPatternDirectory, 4_097);

  const linkedPatternDirectory = join(
    repositoryRoot,
    "node_modules",
    "@typepeek-fixture",
    "symlink-subpath",
    "dist",
    "linked",
  );
  await symlink(
    broadPatternDirectory,
    linkedPatternDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  const internalSymlinkPackageRoot = join(
    repositoryRoot,
    "node_modules",
    "@typepeek-fixture",
    "internal-symlink-subpath",
  );
  const internalPatternDirectory = join(internalSymlinkPackageRoot, "dist", "patterns");
  const internalTreeDirectory = join(internalSymlinkPackageRoot, "tree");
  await mkdir(internalTreeDirectory);
  await Promise.all([
    symlink(
      internalPatternDirectory,
      join(internalSymlinkPackageRoot, "dist-link"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      internalPatternDirectory,
      join(internalTreeDirectory, "patterns"),
      process.platform === "win32" ? "junction" : "dir",
    ),
  ]);
}

async function writeEmptyDeclarationFiles(directory: string, count: number): Promise<void> {
  const batchSize = 256;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) =>
        writeFile(join(directory, `entry-${start + offset}.d.ts`), ""),
      ),
    );
  }
}

async function writePackageSource(fixtureRoot: string, source: PackageSource): Promise<void> {
  const packageRoot = join(fixtureRoot, source.directory);
  const packageDist = join(packageRoot, "dist");
  const manifest = {
    name: source.name,
    version: source.version,
    type: "module",
    types: "./dist/index.d.ts",
    files: ["dist"],
    ...(source.dependencies === undefined ? {} : { dependencies: source.dependencies }),
    ...(source.exports === undefined ? {} : { exports: source.exports }),
  };

  await Promise.all(
    Object.keys(source.additionalDeclarations ?? {}).map((fileName) =>
      mkdir(dirname(join(packageDist, fileName)), { recursive: true }),
    ),
  );
  await mkdir(packageDist, { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest)),
    writeFile(join(packageDist, "index.d.ts"), source.declaration),
    writeFile(join(packageDist, "index.js"), source.runtime),
    ...Object.entries(source.additionalDeclarations ?? {}).map(([fileName, declaration]) =>
      writeFile(join(packageDist, fileName), declaration),
    ),
  ]);
}
