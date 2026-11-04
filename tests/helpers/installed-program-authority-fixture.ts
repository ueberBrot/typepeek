import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { Schema } from "effect";

const PACKAGE_MANIFEST_FILE = "package.json";
const DECLARATION_ENTRY_FILE = "index.d.ts";

const PROCESS_PID_DECLARATION_LINE =
  "declare var process: { readonly pid: number };";

const PROCESS_PID_DECLARATION = `${PROCESS_PID_DECLARATION_LINE}\n`;

const RUNTIME_ONLY = "runtime-only";

const PROCESS_INSPECTION_DECLARATION =
  "export declare function inspect(value: typeof process): number;";

const NODE_PROCESS_DECLARATION = "declare var process: NodeJS.Process;";

const NODE_PROCESS_NAMESPACE =
  "declare namespace NodeJS { interface Process { readonly pid: number; } }";

const GLOBAL_NODE_PROCESS_DECLARATION =
  "declare namespace NodeJS { interface Process { readonly pid: number; } }\ndeclare var process: NodeJS.Process;\n";

export interface InstalledProgramAuthorityFixture {
  readonly automaticProviderContext: string;
  readonly automaticWrongProviderContext: string;
  readonly brokenNodeContext: string;
  readonly brokenPrivateNodeContext: string;
  readonly brokenStandardNodeContext: string;
  readonly cleanup: () => Promise<void>;
  readonly conditionalTypeReferenceContext: string;
  readonly globalNodeContext: string;
  readonly heritageNodeContext: string;
  readonly literalNodeContext: string;
  readonly localNodeContext: string;
  readonly missingNodeContext: string;
  readonly missingNodeMemberContext: string;
  readonly missingNodeModuleContext: string;
  readonly partialNodeContext: string;
  readonly sourceInferredNodeContext: string;
  readonly sourceInferredReturnContext: string;
  readonly sourceInferredLocalContext: string;
  readonly sourceInferredHelperContext: string;
  readonly focusedNodeContext: string;
  readonly sourceInferredTypedContext: string;
  readonly sourceInferredExternalContext: string;
  readonly supportingNodeContext: string;
  readonly privateSupportingNodeContext: string;
  readonly protectedSupportingNodeContext: string;
  readonly namespaceNodeContext: string;
  readonly standardSpacesContext: string;
  readonly inferredNamespaceContext: string;
  readonly privateInferredNamespaceContext: string;
  readonly inferredSupportingMemberContext: string;
  readonly inferredGenericContext: string;
  readonly inferredNodeGenericContext: string;
  readonly overloadImplementationContext: string;
  readonly decoratorContext: string;
  readonly computedNameContext: string;
  readonly invalidStandardContext: string;
  readonly symlinkNodeContext: string;
}

const writeJson = async function writeJson(
  fileName: string,
  value: Schema.Json
): Promise<void> {
  await mkdir(nodePath.dirname(fileName), { recursive: true });
  await writeFile(fileName, `${JSON.stringify(value)}\n`);
};

const preparePackageDirectories = async (
  packageRoot: string,
  providerRoot: string
): Promise<void> => {
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(providerRoot, { recursive: true }),
  ]);
};

const materializeConditionalTypeReferenceContext =
  async function materializeConditionalTypeReferenceContext(
    context: string
  ): Promise<void> {
    const packageName = "@typepeek-fixture/conditional-type-reference";

    const packageRoot = nodePath.join(
      context,
      "node_modules",
      ...packageName.split("/")
    );

    const providerName = "conditional-type-provider";
    const providerRoot = nodePath.join(context, "node_modules", providerName);

    const entries = [
      ["explicit-import", "d.cts", ['resolution-mode="import"']],
      ["explicit-require", "d.mts", ['resolution-mode="require"']],
      ["implicit-import", "d.mts", [""]],
      ["implicit-require", "d.cts", [""]],
      [
        "dual-modes",
        "d.mts",
        ['resolution-mode="import"', 'resolution-mode="require"'],
      ],
    ] as const;

    await preparePackageDirectories(packageRoot, providerRoot);
    await Promise.all([
      writeJson(nodePath.join(context, PACKAGE_MANIFEST_FILE), {
        dependencies: { [packageName]: "1.0.0" },
        name: "@typepeek-fixture/type-reference-context",
        private: true,
      }),
      writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
        dependencies: { [providerName]: "1.0.0" },
        exports: Object.fromEntries(
          entries.map(([name, extension]) => [
            `./${name}`,
            { types: `./${name}.${extension}` },
          ])
        ),
        name: packageName,
        version: "1.0.0",
      }),
      writeJson(nodePath.join(providerRoot, PACKAGE_MANIFEST_FILE), {
        exports: {
          ".": Object.fromEntries([
            ["import", Object.fromEntries([["types", "./import.d.ts"]])],
            ["require", Object.fromEntries([["types", "./require.d.ts"]])],
          ]),
        },
        name: providerName,
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(providerRoot, "import.d.ts"),
        "interface Branch { importOnly: string; }\n"
      ),
      writeFile(
        nodePath.join(providerRoot, "require.d.ts"),
        "interface Branch { requireOnly: number; }\n"
      ),
      ...entries.map(async ([name, extension, modes]) => {
        await writeFile(
          nodePath.join(packageRoot, `${name}.${extension}`),
          [
            ...modes.map(
              (mode) => `/// <reference types="${providerName}" ${mode} />`
            ),
            "export interface Value extends Branch {}",
            "",
          ].join("\n")
        );
      }),
    ]);
  };

const materializeNodeContext = async function materializeNodeContext(
  context: string,
  packageName: string,
  declaration: string,
  nodeDeclaration: string,
  entryFile = DECLARATION_ENTRY_FILE
): Promise<void> {
  const packageRoot = nodePath.join(
    context,
    "node_modules",
    ...packageName.split("/")
  );

  const providerRoot = nodePath.join(context, "node_modules", "@types", "node");
  await preparePackageDirectories(packageRoot, providerRoot);
  await Promise.all([
    writeJson(nodePath.join(context, PACKAGE_MANIFEST_FILE), {
      dependencies: { "@types/node": "99.0.0", [packageName]: "1.0.0" },
      name: "@typepeek-fixture/authority-context",
      private: true,
    }),
    writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
      name: packageName,
      types: entryFile,
      version: "1.0.0",
    }),
    writeFile(nodePath.join(packageRoot, entryFile), declaration),
    writeJson(nodePath.join(providerRoot, PACKAGE_MANIFEST_FILE), {
      name: "@types/node",
      types: DECLARATION_ENTRY_FILE,
      version: "99.0.0",
    }),
    writeFile(
      nodePath.join(providerRoot, DECLARATION_ENTRY_FILE),
      nodeDeclaration
    ),
  ]);
};

const materializeLiteralNodeContext =
  async function materializeLiteralNodeContext(
    context: string,
    options: {
      readonly declaration?: string;
      readonly packageName?: string;
    } = {}
  ): Promise<void> {
    const packageName = options.packageName ?? "@typepeek-fixture/node-literal";
    await materializeNodeContext(
      context,
      packageName,
      options.declaration ?? 'export type BuiltinLiteral = "fs";\n',
      Array.from(
        { length: 2200 },
        (_, index) => `/// <reference path="./part-${index}.d.ts" />`
      ).join("\n")
    );

    const providerRoot = nodePath.join(
      context,
      "node_modules",
      "@types",
      "node"
    );

    await Promise.all(
      Array.from({ length: 2200 }, async (_, index) => {
        await writeFile(
          nodePath.join(providerRoot, `part-${index}.d.ts`),
          `interface NodePart${index} {}\n`
        );
      })
    );
  };

const materializeBrokenNodeContext =
  async function materializeBrokenNodeContext(
    context: string,
    declaration: string,
    entryFile = DECLARATION_ENTRY_FILE
  ): Promise<void> {
    await materializeNodeContext(
      context,
      "@typepeek-fixture/broken-node-consumer",
      declaration,
      PROCESS_PID_DECLARATION,
      entryFile
    );
    await writeFile(
      nodePath.join(
        context,
        "node_modules",
        "@types",
        "node",
        PACKAGE_MANIFEST_FILE
      ),
      '{"types":"missing.d.ts"}\n'
    );
  };

const materializeSymlinkNodeContext =
  async function materializeSymlinkNodeContext(context: string): Promise<void> {
    const packageName = "@typepeek-fixture/node-symlink";
    await materializeNodeContext(
      context,
      packageName,
      'export { escaped } from "./node-link.js";\n',
      "export declare const escaped: string;\n"
    );

    const packageRoot = nodePath.join(
      context,
      "node_modules",
      ...packageName.split("/")
    );

    const providerDeclaration = nodePath.join(
      context,
      "node_modules",
      "@types",
      "node",
      DECLARATION_ENTRY_FILE
    );

    await symlink(
      nodePath.relative(packageRoot, providerDeclaration),
      nodePath.join(packageRoot, "node-link.d.ts"),
      "file"
    );
  };

const materializeAutomaticProviderContext =
  async function materializeAutomaticProviderContext(
    context: string
  ): Promise<void> {
    const parentRoot = nodePath.join(
      context,
      "node_modules",
      "@typepeek-fixture",
      "automatic-provider"
    );

    const runtimeRoot = nodePath.join(context, "node_modules", RUNTIME_ONLY);

    const providerRoot = nodePath.join(
      context,
      "node_modules",
      "@types",
      RUNTIME_ONLY
    );

    await Promise.all([
      mkdir(parentRoot, { recursive: true }),
      mkdir(runtimeRoot, { recursive: true }),
      mkdir(providerRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeJson(nodePath.join(context, PACKAGE_MANIFEST_FILE), {
        dependencies: { "@typepeek-fixture/automatic-provider": "1.0.0" },
        name: "@typepeek-fixture/automatic-provider-context",
        private: true,
      }),
      writeJson(nodePath.join(parentRoot, PACKAGE_MANIFEST_FILE), {
        dependencies: { "runtime-only": "1.0.0" },
        name: "@typepeek-fixture/automatic-provider",
        types: DECLARATION_ENTRY_FILE,
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(parentRoot, DECLARATION_ENTRY_FILE),
        'export { helper } from "runtime-only";\n'
      ),
      writeJson(nodePath.join(runtimeRoot, PACKAGE_MANIFEST_FILE), {
        main: "index.js",
        name: RUNTIME_ONLY,
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(runtimeRoot, "index.js"),
        "module.exports = {};\n"
      ),
      writeJson(nodePath.join(providerRoot, PACKAGE_MANIFEST_FILE), {
        name: "@types/runtime-only",
        types: DECLARATION_ENTRY_FILE,
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(providerRoot, DECLARATION_ENTRY_FILE),
        "export declare function helper(value: string): number;\n"
      ),
    ]);
  };

const materializeExternalInferenceContext =
  async function materializeExternalInferenceContext(
    context: string
  ): Promise<void> {
    const packageName = "@typepeek-fixture/source-inferred-external";
    await materializeNodeContext(
      context,
      packageName,
      'import { get } from "dep"; export function value() { return get(); }\n',
      'declare module "node:fs" { export function readFile(): void; }\n',
      "index.ts"
    );

    const packageRoot = nodePath.join(
      context,
      "node_modules",
      ...packageName.split("/")
    );

    const dependencyRoot = nodePath.join(context, "node_modules", "dep");
    await mkdir(dependencyRoot, { recursive: true });
    await Promise.all([
      writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
        dependencies: { dep: "1.0.0" },
        name: packageName,
        types: "index.ts",
        version: "1.0.0",
      }),
      writeJson(nodePath.join(dependencyRoot, PACKAGE_MANIFEST_FILE), {
        name: "dep",
        types: DECLARATION_ENTRY_FILE,
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(dependencyRoot, DECLARATION_ENTRY_FILE),
        'export declare function get(): typeof import("node:fs");\n'
      ),
    ]);
  };

export const materializeInstalledProgramAuthorityFixture =
  async function materializeInstalledProgramAuthorityFixture(): Promise<InstalledProgramAuthorityFixture> {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek installed-program authority-")
    );

    const literalNodeContext = nodePath.join(fixtureRoot, "literal-node");
    const brokenNodeContext = nodePath.join(fixtureRoot, "broken-node");

    const brokenPrivateNodeContext = nodePath.join(
      fixtureRoot,
      "broken-private-node"
    );

    const brokenStandardNodeContext = nodePath.join(
      fixtureRoot,
      "broken-standard-node"
    );

    const globalNodeContext = nodePath.join(fixtureRoot, "global-node");
    const heritageNodeContext = nodePath.join(fixtureRoot, "heritage-node");
    const localNodeContext = nodePath.join(fixtureRoot, "local-node");
    const symlinkNodeContext = nodePath.join(fixtureRoot, "symlink-node");

    const automaticProviderContext = nodePath.join(
      fixtureRoot,
      "automatic-provider"
    );

    const automaticWrongProviderContext = nodePath.join(
      fixtureRoot,
      "automatic-wrong-provider"
    );

    const missingNodeContext = nodePath.join(fixtureRoot, "missing-node");

    const missingNodeMemberContext = nodePath.join(
      fixtureRoot,
      "missing-node-member"
    );

    const missingNodeModuleContext = nodePath.join(
      fixtureRoot,
      "missing-node-module"
    );

    const partialNodeContext = nodePath.join(fixtureRoot, "partial-node");

    const sourceInferredNodeContext = nodePath.join(
      fixtureRoot,
      "source-inferred-node"
    );

    const sourceInferredReturnContext = nodePath.join(
      fixtureRoot,
      "source-inferred-return"
    );

    const sourceInferredLocalContext = nodePath.join(
      fixtureRoot,
      "source-inferred-local"
    );

    const sourceInferredHelperContext = nodePath.join(
      fixtureRoot,
      "source-inferred-helper"
    );

    const focusedNodeContext = nodePath.join(fixtureRoot, "focused-node");

    const sourceInferredTypedContext = nodePath.join(
      fixtureRoot,
      "source-inferred-typed"
    );

    const sourceInferredExternalContext = nodePath.join(
      fixtureRoot,
      "source-inferred-external"
    );

    const supportingNodeContext = nodePath.join(fixtureRoot, "supporting-node");

    const privateSupportingNodeContext = nodePath.join(
      fixtureRoot,
      "private-supporting-node"
    );

    const protectedSupportingNodeContext = nodePath.join(
      fixtureRoot,
      "protected-supporting-node"
    );

    const namespaceNodeContext = nodePath.join(fixtureRoot, "namespace-node");
    const standardSpacesContext = nodePath.join(fixtureRoot, "standard-spaces");

    const inferredNamespaceContext = nodePath.join(
      fixtureRoot,
      "inferred-namespace"
    );

    const privateInferredNamespaceContext = nodePath.join(
      fixtureRoot,
      "private-inferred-namespace"
    );

    const inferredSupportingMemberContext = nodePath.join(
      fixtureRoot,
      "inferred-supporting-member"
    );

    const inferredGenericContext = nodePath.join(
      fixtureRoot,
      "inferred-generic"
    );

    const inferredNodeGenericContext = nodePath.join(
      fixtureRoot,
      "inferred-node-generic"
    );

    const overloadImplementationContext = nodePath.join(
      fixtureRoot,
      "overload-implementation"
    );

    const decoratorContext = nodePath.join(fixtureRoot, "decorator");
    const computedNameContext = nodePath.join(fixtureRoot, "computed-name");

    const invalidStandardContext = nodePath.join(
      fixtureRoot,
      "invalid-standard"
    );

    const conditionalTypeReferenceContext = nodePath.join(
      fixtureRoot,
      "conditional-type-reference"
    );

    try {
      await materializeConditionalTypeReferenceContext(
        conditionalTypeReferenceContext
      );
      await materializeLiteralNodeContext(literalNodeContext);
      await materializeLiteralNodeContext(brokenNodeContext);
      await writeFile(
        nodePath.join(
          brokenNodeContext,
          "node_modules",
          "@types",
          "node",
          PACKAGE_MANIFEST_FILE
        ),
        '{"types":"missing.d.ts"}\n'
      );
      await materializeBrokenNodeContext(
        brokenPrivateNodeContext,
        [
          "type Hidden = typeof process;",
          "export declare function inspect(value: string): number;",
          "",
        ].join("\n"),
        "index.ts"
      );
      await materializeBrokenNodeContext(
        brokenStandardNodeContext,
        "export declare function inspect(value: Iterable<string>): number;\n"
      );
      await materializeNodeContext(
        globalNodeContext,
        "@typepeek-fixture/node-global",
        [
          "declare global { namespace NodeJS { interface Local { readonly local: true; } } }",
          PROCESS_INSPECTION_DECLARATION,
          "export declare const collector: typeof gc;",
          "export interface Stream extends NodeJS.ReadableStream { readonly own: true; }",
          "",
        ].join("\n"),
        [
          "declare namespace NodeJS {",
          "  interface Process { readonly pid: number; }",
          "  interface ReadableStream { read(): unknown; }",
          "}",
          NODE_PROCESS_DECLARATION,
          "declare var gc: () => void;",
          "",
        ].join("\n")
      );
      await materializeLiteralNodeContext(localNodeContext, {
        declaration: [
          "interface Buffer { readonly local: true; }",
          "export declare function inspect(value: Buffer): number;",
          "",
        ].join("\n"),
        packageName: "@typepeek-fixture/local-node-global",
      });
      await materializeNodeContext(
        heritageNodeContext,
        "@typepeek-fixture/node-heritage",
        "export interface Stream extends NodeJS.ReadableStream { readonly own: true; }\n",
        "declare namespace NodeJS { interface ReadableStream { read(): unknown; } }\n"
      );
      await materializeSymlinkNodeContext(symlinkNodeContext);
      await materializeAutomaticProviderContext(automaticProviderContext);
      await materializeAutomaticProviderContext(automaticWrongProviderContext);
      await writeJson(
        nodePath.join(
          automaticWrongProviderContext,
          "node_modules",
          "@types",
          RUNTIME_ONLY,
          PACKAGE_MANIFEST_FILE
        ),
        {
          name: "attacker-types",
          types: DECLARATION_ENTRY_FILE,
          version: "1.0.0",
        }
      );
      await materializeNodeContext(
        missingNodeContext,
        "@typepeek-fixture/missing-node-global",
        [
          PROCESS_INSPECTION_DECLARATION,
          "export class PrivateToken {",
          "  private constructor(public readonly processValue: typeof process) {}",
          "}",
          "",
        ].join("\n"),
        PROCESS_PID_DECLARATION,
        "index.ts"
      );
      await rm(
        nodePath.join(missingNodeContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        partialNodeContext,
        "@typepeek-fixture/partial-node-global",
        [
          PROCESS_INSPECTION_DECLARATION,
          "export declare const collector: typeof gc;",
          'export type Stat = import("node:fs").Stats;',
          "",
        ].join("\n"),
        [
          PROCESS_PID_DECLARATION_LINE,
          'declare module "node:fs" { export interface Stats { readonly size: number; } }',
          "",
        ].join("\n")
      );
      await materializeNodeContext(
        missingNodeMemberContext,
        "@typepeek-fixture/missing-node-member",
        'export type Missing = import("node:fs").Missing;\n',
        'declare module "node:fs" { export interface Stats { readonly size: number; } }\n'
      );
      await materializeNodeContext(
        missingNodeModuleContext,
        "@typepeek-fixture/missing-node-module",
        'export type Fs = typeof import("node:fs");\n',
        PROCESS_PID_DECLARATION
      );
      await materializeNodeContext(
        sourceInferredNodeContext,
        "@typepeek-fixture/source-inferred-node",
        [
          "export const value = process;",
          "export class Values extends Array<string> {",
          "  readonly proc = process;",
          "  first() { return this.at(0); }",
          "}",
          "export class PrivateToken {",
          "  private constructor(public readonly processValue: typeof process) {}",
          "}",
          "",
        ].join("\n"),
        [NODE_PROCESS_NAMESPACE, NODE_PROCESS_DECLARATION, ""].join("\n"),
        "index.ts"
      );
      await materializeNodeContext(
        sourceInferredReturnContext,
        "@typepeek-fixture/source-inferred-return",
        "export function getProcess() { return process; }\n",
        GLOBAL_NODE_PROCESS_DECLARATION,
        "index.ts"
      );
      await materializeNodeContext(
        sourceInferredLocalContext,
        "@typepeek-fixture/source-inferred-local",
        "export function local() { const p = process; return p; }\n",
        GLOBAL_NODE_PROCESS_DECLARATION,
        "index.ts"
      );
      await materializeNodeContext(
        sourceInferredHelperContext,
        "@typepeek-fixture/source-inferred-helper",
        "export function helper() { function get() { return process; } return get(); }\n",
        GLOBAL_NODE_PROCESS_DECLARATION,
        "index.ts"
      );
      await materializeNodeContext(
        focusedNodeContext,
        "@typepeek-fixture/focused-node",
        [
          "export declare const nodeOnly: typeof process;",
          "export declare function inspect(value: string): number;",
          "export declare function second(value: number): string;",
          "",
        ].join("\n"),
        ""
      );
      await rm(
        nodePath.join(focusedNodeContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        sourceInferredTypedContext,
        "@typepeek-fixture/source-inferred-typed",
        [
          "const p: typeof process = process;",
          'declare const fs: typeof import("node:fs");',
          "export function typedLocal() { return p; }",
          "export function getFs() { return fs; }",
          "",
        ].join("\n"),
        [
          NODE_PROCESS_NAMESPACE,
          NODE_PROCESS_DECLARATION,
          'declare module "node:fs" { export function readFile(): void; }',
          "",
        ].join("\n"),
        "index.ts"
      );
      await materializeExternalInferenceContext(sourceInferredExternalContext);
      await materializeNodeContext(
        supportingNodeContext,
        "@typepeek-fixture/supporting-node",
        "class Result { value!: typeof process; } export const result = new Result();\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(supportingNodeContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        privateSupportingNodeContext,
        "@typepeek-fixture/private-supporting-node",
        [
          "class Result {",
          "  private value!: typeof process;",
          "  #hidden!: typeof process;",
          "  readonly visible = true;",
          "  constructor() { return process as never; }",
          "  method(): string;",
          "  method() { return process; }",
          "  set ignored(value: string) { void value; void process; }",
          "}",
          "export const result = new Result();",
          "",
        ].join("\n"),
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(
          privateSupportingNodeContext,
          "node_modules",
          "@types",
          "node"
        ),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        protectedSupportingNodeContext,
        "@typepeek-fixture/protected-supporting-node",
        "class Result { protected value!: typeof process; readonly visible = true; } export const result = new Result();\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(
          protectedSupportingNodeContext,
          "node_modules",
          "@types",
          "node"
        ),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        namespaceNodeContext,
        "@typepeek-fixture/namespace-node",
        [
          "export namespace API {",
          "  export const proc: typeof process;",
          "  export interface X { value: NodeJS.Process; }",
          "}",
          "",
        ].join("\n"),
        ""
      );
      await rm(
        nodePath.join(namespaceNodeContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        standardSpacesContext,
        "@typepeek-fixture/standard-spaces",
        [
          "export declare function invalidConsole(value: console): void;",
          "export type InvalidIterable = typeof Iterable;",
          "export type InvalidGlobalThis = globalThis;",
          "export type InvalidIntl = Intl;",
          "export type InvalidConst = const;",
          "export type InvalidIteratorObjectConstructor = IteratorObjectConstructor;",
          "export declare function validConsole(value: Console): typeof console;",
          "export declare function validIterable(value: Iterable<string>): typeof globalThis;",
          "export type ValidIntl = typeof Intl & { date: globalThis.Date; formatter: Intl.DateTimeFormat; iterator: typeof Symbol.iterator; iteratorConstructor: IteratorConstructor; iteratorValue: typeof Iterator };",
          "",
        ].join("\n"),
        ""
      );
      await rm(
        nodePath.join(standardSpacesContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        inferredNamespaceContext,
        "@typepeek-fixture/inferred-namespace",
        "namespace API { export const proc: typeof process = process; } export const api = API;\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(
          inferredNamespaceContext,
          "node_modules",
          "@types",
          "node"
        ),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        privateInferredNamespaceContext,
        "@typepeek-fixture/private-inferred-namespace",
        "namespace API { const hidden: typeof process = process; export const ok = 1; } export const api = API;\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(
          privateInferredNamespaceContext,
          "node_modules",
          "@types",
          "node"
        ),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        inferredSupportingMemberContext,
        "@typepeek-fixture/inferred-supporting-member",
        "class Result { get() { return process; } } export const result = new Result();\n",
        GLOBAL_NODE_PROCESS_DECLARATION,
        "index.ts"
      );
      await materializeNodeContext(
        inferredGenericContext,
        "@typepeek-fixture/inferred-generic",
        "declare function id<T>(): T; export const value = id<Iterable<string>>();\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(inferredGenericContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        inferredNodeGenericContext,
        "@typepeek-fixture/inferred-node-generic",
        [
          "declare function id<T>(): T;",
          "export const valid = id<NodeJS.Process>();",
          "export const missing = id<NodeJS.Missing>();",
          "",
        ].join("\n"),
        "declare namespace NodeJS { interface Process { readonly pid: number; } }\n",
        "index.ts"
      );
      await materializeNodeContext(
        overloadImplementationContext,
        "@typepeek-fixture/overload-implementation",
        "export function inspect(): string; export function inspect() { return process; }\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(
          overloadImplementationContext,
          "node_modules",
          "@types",
          "node"
        ),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        decoratorContext,
        "@typepeek-fixture/decorator",
        "declare function dec<T>(): ClassDecorator; @dec<typeof process>() export class Result {}\n",
        "",
        "index.ts"
      );
      await rm(
        nodePath.join(decoratorContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );
      await materializeNodeContext(
        computedNameContext,
        "@typepeek-fixture/computed-name",
        [
          'import { inspect } from "node:util";',
          'export class Bad { [process.pid]: string = "x"; }',
          'export class BadFor { [Symbol.for("x")]: string = "x"; }',
          'export class BadKeyFor { [Symbol.keyFor(Symbol.iterator)]: string = "x"; }',
          'export class Good { *[Symbol.iterator](): IterableIterator<string> { yield "x"; } }',
          "export class Dispose { [Symbol.dispose](): void {} }",
          'export class Custom { [inspect.custom](): string { return "x"; } }',
          "",
        ].join("\n"),
        [
          PROCESS_PID_DECLARATION_LINE,
          'declare module "node:util" { export namespace inspect { const custom: unique symbol; } }',
          "",
        ].join("\n"),
        "index.ts"
      );
      await materializeNodeContext(
        invalidStandardContext,
        "@typepeek-fixture/invalid-standard",
        "export declare function inspect(value: Iterable.Missing): void;\n",
        ""
      );
      await rm(
        nodePath.join(invalidStandardContext, "node_modules", "@types", "node"),
        {
          force: true,
          recursive: true,
        }
      );

      return {
        automaticProviderContext,
        automaticWrongProviderContext,
        brokenNodeContext,
        brokenPrivateNodeContext,
        brokenStandardNodeContext,
        cleanup: async () => {
          await rm(fixtureRoot, { force: true, recursive: true });
        },
        computedNameContext,
        conditionalTypeReferenceContext,
        decoratorContext,
        focusedNodeContext,
        globalNodeContext,
        heritageNodeContext,
        inferredGenericContext,
        inferredNamespaceContext,
        inferredNodeGenericContext,
        inferredSupportingMemberContext,
        invalidStandardContext,
        literalNodeContext,
        localNodeContext,
        missingNodeContext,
        missingNodeMemberContext,
        missingNodeModuleContext,
        namespaceNodeContext,
        overloadImplementationContext,
        partialNodeContext,
        privateInferredNamespaceContext,
        privateSupportingNodeContext,
        protectedSupportingNodeContext,
        sourceInferredExternalContext,
        sourceInferredHelperContext,
        sourceInferredLocalContext,
        sourceInferredNodeContext,
        sourceInferredReturnContext,
        sourceInferredTypedContext,
        standardSpacesContext,
        supportingNodeContext,
        symlinkNodeContext,
      };
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
  };
