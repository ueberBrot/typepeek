import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { Schema } from "effect";
import { constVoid } from "effect/Function";

import type { PackageManagerPin } from "./package-toolchain.ts";
import {
  installDeclaredPackages,
  localPackageSpecifier,
  PACKAGE_MANAGER_PINS,
  packPackage,
} from "./package-toolchain.ts";

const PACKAGE_MANIFEST_FILE = "package.json";
const CONSUMER_ONE = "consumer-one";

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

const writeJson = async function writeJson(
  fileName: string,
  value: Schema.Json
): Promise<void> {
  await writeFile(fileName, JSON.stringify(value));
};

const writeDeclarationPackage = async function writeDeclarationPackage(
  packageRoot: string,
  version: string,
  value: string
): Promise<void> {
  const distRoot = nodePath.join(packageRoot, "dist");
  await mkdir(distRoot, { recursive: true });
  await Promise.all([
    writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
      exports: {
        ".": Object.fromEntries([
          ["types", "./dist/index.d.ts"],
          ["import", "./dist/index.js"],
        ]),
      },
      files: ["dist"],
      name: CONTEXTUAL_PACKAGE,
      type: "module",
      version,
    }),
    writeFile(
      nodePath.join(distRoot, "index.d.ts"),
      `export declare const contextValue: "${value}";\n`
    ),
    writeFile(
      nodePath.join(distRoot, "index.js"),
      'throw new Error("fixture runtime executed");\n'
    ),
  ]);
};

const packContextualPackages = async function packContextualPackages(
  fixtureRoot: string
): Promise<ContextualPackages> {
  const sourcesRoot = nodePath.join(fixtureRoot, "sources");
  const tarballsRoot = nodePath.join(fixtureRoot, "tarballs");
  const consumerOneRoot = nodePath.join(sourcesRoot, "consumer-one-contextual");
  const consumerTwoRoot = nodePath.join(sourcesRoot, "consumer-two-contextual");
  await Promise.all([
    writeDeclarationPackage(consumerOneRoot, "1.0.0", "context-one"),
    writeDeclarationPackage(consumerTwoRoot, "2.0.0", "context-two"),
  ]);

  return {
    consumerOne: await packPackage({
      diagnosticContext: "consumer one contextual Package Module fixture",
      packageRoot: consumerOneRoot,
      tarballsRoot,
    }),
    consumerTwo: await packPackage({
      diagnosticContext: "consumer two contextual Package Module fixture",
      packageRoot: consumerTwoRoot,
      tarballsRoot,
    }),
  };
};

const writeConsumerManifest = async function writeConsumerManifest(
  resolutionContext: string,
  contextualTarball: string,
  includeHiddenWorkspace: boolean,
  includeName: boolean
): Promise<void> {
  await writeJson(nodePath.join(resolutionContext, PACKAGE_MANIFEST_FILE), {
    ...(includeName && {
      name: `fixture-${resolutionContext.endsWith(CONSUMER_ONE) ? CONSUMER_ONE : "consumer-two"}`,
    }),
    dependencies: {
      [CONTEXTUAL_PACKAGE]: localPackageSpecifier(contextualTarball),
      [SOURCE_WORKSPACE_PACKAGE]: "file:../source-workspace",
      ...(includeHiddenWorkspace && {
        [HIDDEN_WORKSPACE_PACKAGE]: "file:../hidden-workspace",
      }),
    },
    private: true,
  });
  await writeJson(nodePath.join(resolutionContext, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "project-source-alias": ["../../project-source/index.ts"],
      },
    },
  });
};

const installedPackageStat = async function installedPackageStat(
  repositoryRoot: string,
  consumerContext: string,
  packageName: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  const candidates = await Promise.all(
    [consumerContext, repositoryRoot].map(
      async (installationRoot) =>
        await lstat(
          nodePath.join(
            installationRoot,
            "node_modules",
            ...packageName.split("/")
          )
        ).catch(constVoid)
    )
  );

  return candidates.find((candidate) => candidate !== undefined);
};

const installedPackageExists = async function installedPackageExists(
  repositoryRoot: string,
  consumerContext: string,
  packageName: string
): Promise<boolean> {
  return (
    (await installedPackageStat(
      repositoryRoot,
      consumerContext,
      packageName
    )) !== undefined
  );
};

const sourceWorkspaceIsLink = async function sourceWorkspaceIsLink(
  repositoryRoot: string,
  consumerContext: string
): Promise<boolean> {
  const installedPackageStatResult = await installedPackageStat(
    repositoryRoot,
    consumerContext,
    SOURCE_WORKSPACE_PACKAGE
  );

  return installedPackageStatResult?.isSymbolicLink() ?? false;
};

const materializeWorkspaceInstallation =
  async function materializeWorkspaceInstallation(
    fixtureRoot: string,
    packages: ContextualPackages,
    packageManager: PackageManagerPin
  ): Promise<WorkspacePackageInstallation> {
    const repositoryRoot = nodePath.join(
      fixtureRoot,
      "repositories",
      packageManager.manager
    );

    const packagesRoot = nodePath.join(repositoryRoot, "packages");
    const consumerOneContext = nodePath.join(packagesRoot, CONSUMER_ONE);
    const consumerTwoContext = nodePath.join(packagesRoot, "consumer-two");
    const sourceWorkspaceRoot = nodePath.join(packagesRoot, "source-workspace");
    const hiddenWorkspaceRoot = nodePath.join(packagesRoot, "hidden-workspace");
    await Promise.all([
      mkdir(consumerOneContext, { recursive: true }),
      mkdir(consumerTwoContext, { recursive: true }),
      mkdir(nodePath.join(sourceWorkspaceRoot, "src"), { recursive: true }),
      mkdir(nodePath.join(hiddenWorkspaceRoot, "dist"), { recursive: true }),
      mkdir(nodePath.join(repositoryRoot, "project-source"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeJson(nodePath.join(repositoryRoot, PACKAGE_MANIFEST_FILE), {
        name: `fixture-${packageManager.manager}-workspace-repository`,
        private: true,
        ...(packageManager.manager !== "pnpm" && {
          workspaces: ["packages/*"],
        }),
      }),
      writeFile(
        nodePath.join(repositoryRoot, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n"
      ),
      writeConsumerManifest(
        consumerOneContext,
        packages.consumerOne,
        false,
        true
      ),
      writeConsumerManifest(
        consumerTwoContext,
        packages.consumerTwo,
        true,
        true
      ),
      writeJson(nodePath.join(sourceWorkspaceRoot, PACKAGE_MANIFEST_FILE), {
        exports: {
          ".": Object.fromEntries([
            ["types", "./src/index.ts"],
            ["import", "./src/index.ts"],
          ]),
        },
        name: SOURCE_WORKSPACE_PACKAGE,
        type: "module",
      }),
      writeFile(
        nodePath.join(sourceWorkspaceRoot, "src", "index.ts"),
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
          `  return \`\${options.mode}:\${implementationSecret}\`;`,
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
        ].join("\n")
      ),
      writeJson(nodePath.join(hiddenWorkspaceRoot, PACKAGE_MANIFEST_FILE), {
        exports: {
          ".": Object.fromEntries([
            ["types", "./dist/index.d.ts"],
            ["import", "./dist/index.js"],
          ]),
        },
        name: HIDDEN_WORKSPACE_PACKAGE,
        type: "module",
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(hiddenWorkspaceRoot, "dist", "index.d.ts"),
        "export declare const hiddenWorkspaceValue: string;\n"
      ),
      writeFile(
        nodePath.join(hiddenWorkspaceRoot, "dist", "index.js"),
        'throw new Error("fixture runtime executed");\n'
      ),
      writeFile(
        nodePath.join(repositoryRoot, "project-source", "index.ts"),
        "export const projectSourceValue = 'must stay outside Package Modules';\n"
      ),
    ]);

    const version = await installDeclaredPackages({
      cacheRoot: fixtureRoot,
      diagnosticContext: `${packageManager.manager} workspace Supported Installation in Resolution Context ${repositoryRoot}`,
      offline: true,
      packageManager,
      resolutionContext: repositoryRoot,
    });

    // Consumer manifests can declare dependencies without their own name or version.
    await writeConsumerManifest(
      consumerOneContext,
      packages.consumerOne,
      false,
      false
    );

    return {
      consumerOneContext,
      consumerTwoContext,
      hiddenWorkspaceInstalledElsewhere: await installedPackageExists(
        repositoryRoot,
        consumerTwoContext,
        HIDDEN_WORKSPACE_PACKAGE
      ),
      hiddenWorkspacePackage: HIDDEN_WORKSPACE_PACKAGE,
      hiddenWorkspaceResolvableFromConsumerOne: await installedPackageExists(
        repositoryRoot,
        consumerOneContext,
        HIDDEN_WORKSPACE_PACKAGE
      ),
      manager: packageManager.manager,
      sourceWorkspaceIsLink: await sourceWorkspaceIsLink(
        repositoryRoot,
        consumerOneContext
      ),
      sourceWorkspacePackage: SOURCE_WORKSPACE_PACKAGE,
      version,
    };
  };

export const materializeWorkspacePackageMatrix =
  async function materializeWorkspacePackageMatrix(): Promise<WorkspacePackageMatrix> {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek workspace matrix-")
    );

    try {
      const packages = await packContextualPackages(fixtureRoot);
      const installations: WorkspacePackageInstallation[] = [];

      await Array.fromAsync(PACKAGE_MANAGER_PINS, async (packageManager) => {
        installations.push(
          await materializeWorkspaceInstallation(
            fixtureRoot,
            packages,
            packageManager
          )
        );
      });

      return {
        cleanup: async () => {
          await rm(fixtureRoot, { force: true, recursive: true });
        },
        installations,
      };
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
  };
