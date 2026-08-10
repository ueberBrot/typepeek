import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export interface InstalledProgramAuthorityFixture {
  readonly automaticProviderContext: string;
  readonly automaticWrongProviderContext: string;
  readonly brokenNodeContext: string;
  readonly brokenPrivateNodeContext: string;
  readonly brokenStandardNodeContext: string;
  readonly cleanup: () => Promise<void>;
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

export async function materializeInstalledProgramAuthorityFixture(): Promise<InstalledProgramAuthorityFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek installed-program authority-"));
  const literalNodeContext = join(fixtureRoot, "literal-node");
  const brokenNodeContext = join(fixtureRoot, "broken-node");
  const brokenPrivateNodeContext = join(fixtureRoot, "broken-private-node");
  const brokenStandardNodeContext = join(fixtureRoot, "broken-standard-node");
  const globalNodeContext = join(fixtureRoot, "global-node");
  const heritageNodeContext = join(fixtureRoot, "heritage-node");
  const localNodeContext = join(fixtureRoot, "local-node");
  const symlinkNodeContext = join(fixtureRoot, "symlink-node");
  const automaticProviderContext = join(fixtureRoot, "automatic-provider");
  const automaticWrongProviderContext = join(fixtureRoot, "automatic-wrong-provider");
  const missingNodeContext = join(fixtureRoot, "missing-node");
  const missingNodeMemberContext = join(fixtureRoot, "missing-node-member");
  const missingNodeModuleContext = join(fixtureRoot, "missing-node-module");
  const partialNodeContext = join(fixtureRoot, "partial-node");
  const sourceInferredNodeContext = join(fixtureRoot, "source-inferred-node");
  const sourceInferredReturnContext = join(fixtureRoot, "source-inferred-return");
  const sourceInferredLocalContext = join(fixtureRoot, "source-inferred-local");
  const sourceInferredHelperContext = join(fixtureRoot, "source-inferred-helper");
  const focusedNodeContext = join(fixtureRoot, "focused-node");
  const sourceInferredTypedContext = join(fixtureRoot, "source-inferred-typed");
  const sourceInferredExternalContext = join(fixtureRoot, "source-inferred-external");
  const supportingNodeContext = join(fixtureRoot, "supporting-node");
  const privateSupportingNodeContext = join(fixtureRoot, "private-supporting-node");
  const protectedSupportingNodeContext = join(fixtureRoot, "protected-supporting-node");
  const namespaceNodeContext = join(fixtureRoot, "namespace-node");
  const standardSpacesContext = join(fixtureRoot, "standard-spaces");
  const inferredNamespaceContext = join(fixtureRoot, "inferred-namespace");
  const privateInferredNamespaceContext = join(fixtureRoot, "private-inferred-namespace");
  const inferredSupportingMemberContext = join(fixtureRoot, "inferred-supporting-member");
  const inferredGenericContext = join(fixtureRoot, "inferred-generic");
  const inferredNodeGenericContext = join(fixtureRoot, "inferred-node-generic");
  const overloadImplementationContext = join(fixtureRoot, "overload-implementation");
  const decoratorContext = join(fixtureRoot, "decorator");
  const computedNameContext = join(fixtureRoot, "computed-name");
  const invalidStandardContext = join(fixtureRoot, "invalid-standard");
  try {
    await materializeLiteralNodeContext(literalNodeContext);
    await materializeLiteralNodeContext(brokenNodeContext);
    await writeFile(
      join(brokenNodeContext, "node_modules", "@types", "node", "package.json"),
      '{"types":"missing.d.ts"}\n',
    );
    await materializeBrokenNodeContext(
      brokenPrivateNodeContext,
      [
        "type Hidden = typeof process;",
        "export declare function inspect(value: string): number;",
        "",
      ].join("\n"),
      "index.ts",
    );
    await materializeBrokenNodeContext(
      brokenStandardNodeContext,
      "export declare function inspect(value: Iterable<string>): number;\n",
    );
    await materializeNodeContext(
      globalNodeContext,
      "@typepeek-fixture/node-global",
      [
        "declare global { namespace NodeJS { interface Local { readonly local: true; } } }",
        "export declare function inspect(value: typeof process): number;",
        "export declare const collector: typeof gc;",
        "export interface Stream extends NodeJS.ReadableStream { readonly own: true; }",
        "",
      ].join("\n"),
      [
        "declare namespace NodeJS {",
        "  interface Process { readonly pid: number; }",
        "  interface ReadableStream { read(): unknown; }",
        "}",
        "declare var process: NodeJS.Process;",
        "declare var gc: () => void;",
        "",
      ].join("\n"),
    );
    await materializeLiteralNodeContext(localNodeContext, {
      packageName: "@typepeek-fixture/local-node-global",
      declaration: [
        "interface Buffer { readonly local: true; }",
        "export declare function inspect(value: Buffer): number;",
        "",
      ].join("\n"),
    });
    await materializeNodeContext(
      heritageNodeContext,
      "@typepeek-fixture/node-heritage",
      "export interface Stream extends NodeJS.ReadableStream { readonly own: true; }\n",
      "declare namespace NodeJS { interface ReadableStream { read(): unknown; } }\n",
    );
    await materializeSymlinkNodeContext(symlinkNodeContext);
    await materializeAutomaticProviderContext(automaticProviderContext);
    await materializeAutomaticProviderContext(automaticWrongProviderContext);
    await writeJson(
      join(automaticWrongProviderContext, "node_modules", "@types", "runtime-only", "package.json"),
      { name: "attacker-types", version: "1.0.0", types: "index.d.ts" },
    );
    await materializeNodeContext(
      missingNodeContext,
      "@typepeek-fixture/missing-node-global",
      "export declare function inspect(value: typeof process): number;\n",
      "declare var process: { readonly pid: number };\n",
    );
    await rm(join(missingNodeContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    await materializeNodeContext(
      partialNodeContext,
      "@typepeek-fixture/partial-node-global",
      [
        "export declare function inspect(value: typeof process): number;",
        "export declare const collector: typeof gc;",
        'export type Stat = import("node:fs").Stats;',
        "",
      ].join("\n"),
      [
        "declare var process: { readonly pid: number };",
        'declare module "node:fs" { export interface Stats { readonly size: number; } }',
        "",
      ].join("\n"),
    );
    await materializeNodeContext(
      missingNodeMemberContext,
      "@typepeek-fixture/missing-node-member",
      'export type Missing = import("node:fs").Missing;\n',
      'declare module "node:fs" { export interface Stats { readonly size: number; } }\n',
    );
    await materializeNodeContext(
      missingNodeModuleContext,
      "@typepeek-fixture/missing-node-module",
      'export type Fs = typeof import("node:fs");\n',
      "declare var process: { readonly pid: number };\n",
    );
    await materializeNodeContext(
      sourceInferredNodeContext,
      "@typepeek-fixture/source-inferred-node",
      "export const value = process;\n",
      [
        "declare namespace NodeJS { interface Process { readonly pid: number; } }",
        "declare var process: NodeJS.Process;",
        "",
      ].join("\n"),
      "index.ts",
    );
    await materializeNodeContext(
      sourceInferredReturnContext,
      "@typepeek-fixture/source-inferred-return",
      "export function getProcess() { return process; }\n",
      "declare namespace NodeJS { interface Process { readonly pid: number; } }\ndeclare var process: NodeJS.Process;\n",
      "index.ts",
    );
    await materializeNodeContext(
      sourceInferredLocalContext,
      "@typepeek-fixture/source-inferred-local",
      "export function local() { const p = process; return p; }\n",
      "declare namespace NodeJS { interface Process { readonly pid: number; } }\ndeclare var process: NodeJS.Process;\n",
      "index.ts",
    );
    await materializeNodeContext(
      sourceInferredHelperContext,
      "@typepeek-fixture/source-inferred-helper",
      "export function helper() { function get() { return process; } return get(); }\n",
      "declare namespace NodeJS { interface Process { readonly pid: number; } }\ndeclare var process: NodeJS.Process;\n",
      "index.ts",
    );
    await materializeNodeContext(
      focusedNodeContext,
      "@typepeek-fixture/focused-node",
      [
        "export declare const nodeOnly: typeof process;",
        "export declare function inspect(value: string): number;",
        "",
      ].join("\n"),
      "",
    );
    await rm(join(focusedNodeContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
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
        "declare namespace NodeJS { interface Process { readonly pid: number; } }",
        "declare var process: NodeJS.Process;",
        'declare module "node:fs" { export function readFile(): void; }',
        "",
      ].join("\n"),
      "index.ts",
    );
    await materializeExternalInferenceContext(sourceInferredExternalContext);
    await materializeNodeContext(
      supportingNodeContext,
      "@typepeek-fixture/supporting-node",
      "class Result { value!: typeof process; } export const result = new Result();\n",
      "",
      "index.ts",
    );
    await rm(join(supportingNodeContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
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
      "index.ts",
    );
    await rm(join(privateSupportingNodeContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    await materializeNodeContext(
      protectedSupportingNodeContext,
      "@typepeek-fixture/protected-supporting-node",
      "class Result { protected value!: typeof process; readonly visible = true; } export const result = new Result();\n",
      "",
      "index.ts",
    );
    await rm(join(protectedSupportingNodeContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
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
      "",
    );
    await rm(join(namespaceNodeContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
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
      "",
    );
    await rm(join(standardSpacesContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    await materializeNodeContext(
      inferredNamespaceContext,
      "@typepeek-fixture/inferred-namespace",
      "namespace API { export const proc: typeof process = process; } export const api = API;\n",
      "",
      "index.ts",
    );
    await rm(join(inferredNamespaceContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    await materializeNodeContext(
      privateInferredNamespaceContext,
      "@typepeek-fixture/private-inferred-namespace",
      "namespace API { const hidden: typeof process = process; export const ok = 1; } export const api = API;\n",
      "",
      "index.ts",
    );
    await rm(join(privateInferredNamespaceContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    await materializeNodeContext(
      inferredSupportingMemberContext,
      "@typepeek-fixture/inferred-supporting-member",
      "class Result { get() { return process; } } export const result = new Result();\n",
      "declare namespace NodeJS { interface Process { readonly pid: number; } }\ndeclare var process: NodeJS.Process;\n",
      "index.ts",
    );
    await materializeNodeContext(
      inferredGenericContext,
      "@typepeek-fixture/inferred-generic",
      "declare function id<T>(): T; export const value = id<Iterable<string>>();\n",
      "",
      "index.ts",
    );
    await rm(join(inferredGenericContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
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
      "index.ts",
    );
    await materializeNodeContext(
      overloadImplementationContext,
      "@typepeek-fixture/overload-implementation",
      "export function inspect(): string; export function inspect() { return process; }\n",
      "",
      "index.ts",
    );
    await rm(join(overloadImplementationContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    await materializeNodeContext(
      decoratorContext,
      "@typepeek-fixture/decorator",
      "declare function dec<T>(): ClassDecorator; @dec<typeof process>() export class Result {}\n",
      "",
      "index.ts",
    );
    await rm(join(decoratorContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
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
        "declare var process: { readonly pid: number };",
        'declare module "node:util" { export namespace inspect { const custom: unique symbol; } }',
        "",
      ].join("\n"),
      "index.ts",
    );
    await materializeNodeContext(
      invalidStandardContext,
      "@typepeek-fixture/invalid-standard",
      "export declare function inspect(value: Iterable.Missing): void;\n",
      "",
    );
    await rm(join(invalidStandardContext, "node_modules", "@types", "node"), {
      recursive: true,
      force: true,
    });
    return {
      automaticProviderContext,
      automaticWrongProviderContext,
      brokenNodeContext,
      brokenPrivateNodeContext,
      brokenStandardNodeContext,
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
      globalNodeContext,
      heritageNodeContext,
      literalNodeContext,
      localNodeContext,
      missingNodeContext,
      missingNodeMemberContext,
      missingNodeModuleContext,
      partialNodeContext,
      sourceInferredNodeContext,
      sourceInferredReturnContext,
      sourceInferredLocalContext,
      sourceInferredHelperContext,
      focusedNodeContext,
      sourceInferredTypedContext,
      sourceInferredExternalContext,
      supportingNodeContext,
      privateSupportingNodeContext,
      protectedSupportingNodeContext,
      namespaceNodeContext,
      standardSpacesContext,
      inferredNamespaceContext,
      privateInferredNamespaceContext,
      inferredSupportingMemberContext,
      inferredGenericContext,
      inferredNodeGenericContext,
      overloadImplementationContext,
      decoratorContext,
      computedNameContext,
      invalidStandardContext,
      symlinkNodeContext,
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function materializeExternalInferenceContext(context: string): Promise<void> {
  const packageName = "@typepeek-fixture/source-inferred-external";
  await materializeNodeContext(
    context,
    packageName,
    'import { get } from "dep"; export function value() { return get(); }\n',
    'declare module "node:fs" { export function readFile(): void; }\n',
    "index.ts",
  );
  const packageRoot = join(context, "node_modules", ...packageName.split("/"));
  const dependencyRoot = join(context, "node_modules", "dep");
  await mkdir(dependencyRoot, { recursive: true });
  await Promise.all([
    writeJson(join(packageRoot, "package.json"), {
      name: packageName,
      version: "1.0.0",
      types: "index.ts",
      dependencies: { dep: "1.0.0" },
    }),
    writeJson(join(dependencyRoot, "package.json"), {
      name: "dep",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    writeFile(
      join(dependencyRoot, "index.d.ts"),
      'export declare function get(): typeof import("node:fs");\n',
    ),
  ]);
}

async function materializeBrokenNodeContext(
  context: string,
  declaration: string,
  entryFile = "index.d.ts",
): Promise<void> {
  await materializeNodeContext(
    context,
    "@typepeek-fixture/broken-node-consumer",
    declaration,
    "declare var process: { readonly pid: number };\n",
    entryFile,
  );
  await writeFile(
    join(context, "node_modules", "@types", "node", "package.json"),
    '{"types":"missing.d.ts"}\n',
  );
}

async function materializeLiteralNodeContext(
  context: string,
  options: {
    readonly declaration?: string;
    readonly packageName?: string;
  } = {},
): Promise<void> {
  const packageName = options.packageName ?? "@typepeek-fixture/node-literal";
  await materializeNodeContext(
    context,
    packageName,
    options.declaration ?? 'export type BuiltinLiteral = "fs";\n',
    Array.from({ length: 384 }, (_, index) => `/// <reference path="./part-${index}.d.ts" />`).join(
      "\n",
    ),
  );
  const providerRoot = join(context, "node_modules", "@types", "node");
  await Promise.all(
    Array.from({ length: 384 }, (_, index) =>
      writeFile(join(providerRoot, `part-${index}.d.ts`), `interface NodePart${index} {}\n`),
    ),
  );
}

async function materializeNodeContext(
  context: string,
  packageName: string,
  declaration: string,
  nodeDeclaration: string,
  entryFile = "index.d.ts",
): Promise<void> {
  const packageRoot = join(context, "node_modules", ...packageName.split("/"));
  const providerRoot = join(context, "node_modules", "@types", "node");
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(providerRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeJson(join(context, "package.json"), {
      name: "@typepeek-fixture/authority-context",
      private: true,
      dependencies: { [packageName]: "1.0.0", "@types/node": "99.0.0" },
    }),
    writeJson(join(packageRoot, "package.json"), {
      name: packageName,
      version: "1.0.0",
      types: entryFile,
    }),
    writeFile(join(packageRoot, entryFile), declaration),
    writeJson(join(providerRoot, "package.json"), {
      name: "@types/node",
      version: "99.0.0",
      types: "index.d.ts",
    }),
    writeFile(join(providerRoot, "index.d.ts"), nodeDeclaration),
  ]);
}

async function materializeSymlinkNodeContext(context: string): Promise<void> {
  const packageName = "@typepeek-fixture/node-symlink";
  await materializeNodeContext(
    context,
    packageName,
    'export { escaped } from "./node-link.js";\n',
    "export declare const escaped: string;\n",
  );
  const packageRoot = join(context, "node_modules", ...packageName.split("/"));
  const providerDeclaration = join(context, "node_modules", "@types", "node", "index.d.ts");
  await symlink(
    relative(packageRoot, providerDeclaration),
    join(packageRoot, "node-link.d.ts"),
    "file",
  );
}

async function materializeAutomaticProviderContext(context: string): Promise<void> {
  const parentRoot = join(context, "node_modules", "@typepeek-fixture", "automatic-provider");
  const runtimeRoot = join(context, "node_modules", "runtime-only");
  const providerRoot = join(context, "node_modules", "@types", "runtime-only");
  await Promise.all([
    mkdir(parentRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(providerRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeJson(join(context, "package.json"), {
      name: "@typepeek-fixture/automatic-provider-context",
      private: true,
      dependencies: { "@typepeek-fixture/automatic-provider": "1.0.0" },
    }),
    writeJson(join(parentRoot, "package.json"), {
      name: "@typepeek-fixture/automatic-provider",
      version: "1.0.0",
      types: "index.d.ts",
      dependencies: { "runtime-only": "1.0.0" },
    }),
    writeFile(join(parentRoot, "index.d.ts"), 'export { helper } from "runtime-only";\n'),
    writeJson(join(runtimeRoot, "package.json"), {
      name: "runtime-only",
      version: "1.0.0",
      main: "index.js",
    }),
    writeFile(join(runtimeRoot, "index.js"), "module.exports = {};\n"),
    writeJson(join(providerRoot, "package.json"), {
      name: "@types/runtime-only",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    writeFile(
      join(providerRoot, "index.d.ts"),
      "export declare function helper(value: string): number;\n",
    ),
  ]);
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await mkdir(dirname(fileName), { recursive: true });
  await writeFile(fileName, `${JSON.stringify(value)}\n`);
}
