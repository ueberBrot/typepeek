import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installDeclaredPackages,
  localPackageSpecifier,
  type PackageManagerPin,
  PACKAGE_MANAGER_PINS,
  packPackage,
} from "./package-toolchain.ts";

const CONTEXTUAL_PACKAGE = "@typepeek-fixture/contextual";
const HIDDEN_WORKSPACE_PACKAGE = "@typepeek-fixture/hidden-workspace";
const SOURCE_WORKSPACE_PACKAGE = "@typepeek-fixture/source-workspace";

export interface WorkspacePackageInstallation {
  readonly consumerOneContext: string;
  readonly consumerTwoContext: string;
  readonly hiddenWorkspaceInstalledElsewhere: boolean;
  readonly hiddenWorkspacePackage: string;
  readonly hiddenWorkspaceResolvableFromConsumerOne: boolean;
  readonly manager: PackageManagerPin["manager"];
  readonly sourceWorkspaceIsLink: boolean;
  readonly sourceWorkspacePackage: string;
  readonly version: string;
}

export interface WorkspacePackageMatrix {
  readonly installations: readonly WorkspacePackageInstallation[];
  readonly cleanup: () => Promise<void>;
}

interface ContextualPackages {
  readonly consumerOne: string;
  readonly consumerTwo: string;
}

export async function materializeWorkspacePackageMatrix(): Promise<WorkspacePackageMatrix> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek workspace matrix-"));

  try {
    const packages = await packContextualPackages(fixtureRoot);
    const installations = [];
    for (const packageManager of PACKAGE_MANAGER_PINS) {
      installations.push(
        await materializeWorkspaceInstallation(fixtureRoot, packages, packageManager),
      );
    }
    return {
      installations,
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function packContextualPackages(fixtureRoot: string): Promise<ContextualPackages> {
  const sourcesRoot = join(fixtureRoot, "sources");
  const tarballsRoot = join(fixtureRoot, "tarballs");
  const npmCacheRoot = join(fixtureRoot, "npm-cache");
  const consumerOneRoot = join(sourcesRoot, "consumer-one-contextual");
  const consumerTwoRoot = join(sourcesRoot, "consumer-two-contextual");
  await Promise.all([
    writeDeclarationPackage(consumerOneRoot, "1.0.0", "context-one"),
    writeDeclarationPackage(consumerTwoRoot, "2.0.0", "context-two"),
  ]);
  return {
    consumerOne: await packPackage({
      diagnosticContext: "consumer one contextual Package Module fixture",
      npmCacheRoot,
      packageRoot: consumerOneRoot,
      tarballsRoot,
    }),
    consumerTwo: await packPackage({
      diagnosticContext: "consumer two contextual Package Module fixture",
      npmCacheRoot,
      packageRoot: consumerTwoRoot,
      tarballsRoot,
    }),
  };
}

async function writeDeclarationPackage(
  packageRoot: string,
  version: string,
  value: string,
): Promise<void> {
  const distRoot = join(packageRoot, "dist");
  await mkdir(distRoot, { recursive: true });
  await Promise.all([
    writeJson(join(packageRoot, "package.json"), {
      name: CONTEXTUAL_PACKAGE,
      version,
      type: "module",
      files: ["dist"],
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    }),
    writeFile(join(distRoot, "index.d.ts"), `export declare const contextValue: "${value}";\n`),
    writeFile(join(distRoot, "index.js"), 'throw new Error("fixture runtime executed");\n'),
  ]);
}

async function materializeWorkspaceInstallation(
  fixtureRoot: string,
  packages: ContextualPackages,
  packageManager: PackageManagerPin,
): Promise<WorkspacePackageInstallation> {
  const repositoryRoot = join(fixtureRoot, "repositories", packageManager.manager);
  const packagesRoot = join(repositoryRoot, "packages");
  const consumerOneContext = join(packagesRoot, "consumer-one");
  const consumerTwoContext = join(packagesRoot, "consumer-two");
  const sourceWorkspaceRoot = join(packagesRoot, "source-workspace");
  const hiddenWorkspaceRoot = join(packagesRoot, "hidden-workspace");
  await Promise.all([
    mkdir(consumerOneContext, { recursive: true }),
    mkdir(consumerTwoContext, { recursive: true }),
    mkdir(join(sourceWorkspaceRoot, "src"), { recursive: true }),
    mkdir(join(hiddenWorkspaceRoot, "dist"), { recursive: true }),
    mkdir(join(repositoryRoot, "project-source"), { recursive: true }),
  ]);

  await Promise.all([
    writeJson(join(repositoryRoot, "package.json"), {
      name: `fixture-${packageManager.manager}-workspace-repository`,
      private: true,
      ...(packageManager.manager === "pnpm" ? {} : { workspaces: ["packages/*"] }),
    }),
    writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeConsumerManifest(consumerOneContext, packages.consumerOne, false, true),
    writeConsumerManifest(consumerTwoContext, packages.consumerTwo, true, true),
    writeJson(join(sourceWorkspaceRoot, "package.json"), {
      name: SOURCE_WORKSPACE_PACKAGE,
      type: "module",
      exports: {
        ".": {
          types: "./src/index.ts",
          import: "./src/index.ts",
        },
      },
    }),
    writeFile(
      join(sourceWorkspaceRoot, "src", "index.ts"),
      [
        'const implementationSecret = "must not be rendered";',
        'export const inferredWorkspaceValue = { mode: "source" as const, angle: <const>"angle" };',
        "class WorkspaceShape { readonly value = 1; }",
        "interface ImplementationOnly { hidden: string }",
        "class HiddenMemberShape { readonly hidden = true; }",
        "class PublicCarrier {",
        "  private readonly hidden = new HiddenMemberShape();",
        "  readonly value = 1;",
        "}",
        "type Box<T> = { value: T };",
        "function makeBox<T>(value: T): Box<T> { return { value }; }",
        "export const inferredWorkspaceShape = new WorkspaceShape();",
        "export const inferredCarrier = new PublicCarrier();",
        "export const boxedWorkspaceShape = makeBox(new WorkspaceShape());",
        "export const workspaceValues = [1, 2];",
        "export const nestedWorkspaceLoader = { async load() { return 1; } };",
        'const workspaceOriginal = { value: "visible" };',
        "export const { value: destructuredWorkspaceValue } = workspaceOriginal;",
        'const workspaceAliasOriginal = { value: "visible" };',
        "const { value: workspaceAliasValue } = workspaceAliasOriginal;",
        "export { workspaceAliasValue as aliasedDestructuredWorkspaceValue };",
        "export function makeWorkspaceShape() { return new WorkspaceShape(); }",
        "export function makeLocalWorkspaceValue() {",
        "  class LocalWorkspaceValue { readonly value = 1; }",
        "  return new LocalWorkspaceValue();",
        "}",
        "export function publicWorkspaceNumber(): number {",
        '  const local: ImplementationOnly = { hidden: "hidden" };',
        "  return local.hidden.length;",
        "}",
        "export function overloadedWorkspaceValue(value: string): string;",
        "export function overloadedWorkspaceValue(value: number): number;",
        "export function overloadedWorkspaceValue(value: string | number) { return value; }",
        "export namespace WorkspaceOverloadTools {",
        "  export function run(value: string): string;",
        "  export function run(value: string | number) { return String(value); }",
        "  export function unrelated() { return 1; }",
        "}",
        "export class MixedOverloads {",
        "  static run(value: string): string;",
        "  static run(value: string | number) { return String(value); }",
        "  run() { return 1; }",
        "}",
        "export async function loadWorkspaceValue() { return 1; }",
        "export const loadWorkspaceArrow = async () => 1;",
        "export interface WorkspaceOptions {",
        '  readonly mode: "source";',
        "}",
        "export function createWorkspaceThing(options: WorkspaceOptions): string {",
        "  return `${options.mode}:${implementationSecret}`;",
        "}",
        "export namespace WorkspaceTools {",
        "  export function createLabel() {",
        "    return implementationSecret;",
        "  }",
        "}",
        "export class WorkspaceSource {",
        "  static { void implementationSecret; }",
        '  readonly mode = "source" as const;',
        "  private readonly secret = implementationSecret;",
        "  createLabel() {",
        "    return implementationSecret;",
        "  }",
        "}",
        "",
      ].join("\n"),
    ),
    writeJson(join(hiddenWorkspaceRoot, "package.json"), {
      name: HIDDEN_WORKSPACE_PACKAGE,
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    }),
    writeFile(
      join(hiddenWorkspaceRoot, "dist", "index.d.ts"),
      "export declare const hiddenWorkspaceValue: string;\n",
    ),
    writeFile(
      join(hiddenWorkspaceRoot, "dist", "index.js"),
      'throw new Error("fixture runtime executed");\n',
    ),
    writeFile(
      join(repositoryRoot, "project-source", "index.ts"),
      "export const projectSourceValue = 'must stay outside Package Modules';\n",
    ),
  ]);

  const version = await installDeclaredPackages({
    cacheRoot: fixtureRoot,
    diagnosticContext: `${packageManager.manager} workspace Supported Installation in Resolution Context ${repositoryRoot}`,
    offline: true,
    packageManager,
    resolutionContext: repositoryRoot,
  });
  // A Resolution Context manifest may legitimately declare dependencies without
  // declaring its own Package Identity.
  await writeConsumerManifest(consumerOneContext, packages.consumerOne, false, false);
  return {
    consumerOneContext,
    consumerTwoContext,
    hiddenWorkspaceInstalledElsewhere: await installedPackageExists(
      repositoryRoot,
      consumerTwoContext,
      HIDDEN_WORKSPACE_PACKAGE,
    ),
    hiddenWorkspacePackage: HIDDEN_WORKSPACE_PACKAGE,
    hiddenWorkspaceResolvableFromConsumerOne: await installedPackageExists(
      repositoryRoot,
      consumerOneContext,
      HIDDEN_WORKSPACE_PACKAGE,
    ),
    manager: packageManager.manager,
    sourceWorkspaceIsLink: await sourceWorkspaceIsLink(repositoryRoot, consumerOneContext),
    sourceWorkspacePackage: SOURCE_WORKSPACE_PACKAGE,
    version,
  };
}

async function installedPackageExists(
  repositoryRoot: string,
  consumerContext: string,
  packageName: string,
): Promise<boolean> {
  return (await installedPackageStat(repositoryRoot, consumerContext, packageName)) !== undefined;
}

async function installedPackageStat(
  repositoryRoot: string,
  consumerContext: string,
  packageName: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  for (const installationRoot of [consumerContext, repositoryRoot]) {
    try {
      return await lstat(join(installationRoot, "node_modules", ...packageName.split("/")));
    } catch {
      // Try the next package-manager placement.
    }
  }
  return undefined;
}

async function sourceWorkspaceIsLink(
  repositoryRoot: string,
  consumerContext: string,
): Promise<boolean> {
  return (
    (
      await installedPackageStat(repositoryRoot, consumerContext, SOURCE_WORKSPACE_PACKAGE)
    )?.isSymbolicLink() ?? false
  );
}

async function writeConsumerManifest(
  resolutionContext: string,
  contextualTarball: string,
  includeHiddenWorkspace: boolean,
  includeName: boolean,
): Promise<void> {
  await writeJson(join(resolutionContext, "package.json"), {
    ...(includeName
      ? {
          name: `fixture-${resolutionContext.endsWith("consumer-one") ? "consumer-one" : "consumer-two"}`,
        }
      : {}),
    private: true,
    dependencies: {
      [CONTEXTUAL_PACKAGE]: localPackageSpecifier(contextualTarball),
      [SOURCE_WORKSPACE_PACKAGE]: "file:../source-workspace",
      ...(includeHiddenWorkspace ? { [HIDDEN_WORKSPACE_PACKAGE]: "file:../hidden-workspace" } : {}),
    },
  });
  await writeJson(join(resolutionContext, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "project-source-alias": ["../../project-source/index.ts"],
      },
    },
  });
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await writeFile(fileName, JSON.stringify(value));
}
