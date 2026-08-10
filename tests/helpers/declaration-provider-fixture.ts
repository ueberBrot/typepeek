import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { installPackedPackagesWithNpm, packPackage } from "./package-toolchain.ts";

const PACKAGE_NAME = "typepeek-provider-target";
const PROVIDER_NAME = "@types/typepeek-provider-target";

export interface DeclarationProviderFixture {
  readonly ambientProviderContext: string;
  readonly brokenExportEqualsNodeProviderContext: string;
  readonly brokenNodeProviderContext: string;
  readonly injectedNodeProviderContext: string;
  readonly nestedProviderContext: string;
  readonly exportedImportNodeProviderContext: string;
  readonly missingProviderContext: string;
  readonly packageName: string;
  readonly providerName: string;
  readonly providerOneContext: string;
  readonly providerOnlyContext: string;
  readonly selfTypedWithMalformedProviderContext: string;
  readonly providerTwoContext: string;
  readonly cleanup: () => Promise<void>;
}

export interface NodeProviderFixture {
  readonly resolutionContext: string;
  readonly cleanup: () => Promise<void>;
}

export async function materializeNodeProviderFixture(
  declaration: string,
  helperDeclaration?: string,
  helperPackageName = "helper",
  helperInstallation: "declared" | "nested-undeclared" = "declared",
): Promise<NodeProviderFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek node provider-"));
  try {
    const providerRoot = join(fixtureRoot, "provider");
    const tarballsRoot = join(fixtureRoot, "tarballs");
    const npmCacheRoot = join(fixtureRoot, "npm-cache");
    const resolutionContext = join(fixtureRoot, "context");
    await writeNodeDeclarationProvider(
      providerRoot,
      "95.0.0",
      declaration,
      helperDeclaration === undefined || helperInstallation === "nested-undeclared"
        ? undefined
        : { [helperPackageName]: "*" },
    );
    const providerTarball = await packFixture(
      providerRoot,
      tarballsRoot,
      npmCacheRoot,
      "single node provider",
    );
    const helperTarball = await materializeOptionalHelper(
      fixtureRoot,
      tarballsRoot,
      npmCacheRoot,
      helperDeclaration,
      helperPackageName,
      helperInstallation,
    );
    await installContext(
      resolutionContext,
      helperTarball === undefined ? [providerTarball] : [providerTarball, helperTarball],
      npmCacheRoot,
      "single node provider context",
    );
    if (helperDeclaration !== undefined && helperInstallation === "nested-undeclared") {
      await installNestedHelper(resolutionContext, helperPackageName, helperDeclaration);
    }
    return {
      resolutionContext,
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeAliasedTypeReferenceFixture(
  declaredDependency: "@types/helper" | "@types/actual-helper",
  layout: "npm" | "pnpm" = "npm",
): Promise<NodeProviderFixture> {
  const fixture = await materializeNodeProviderFixture(
    [
      '/// <reference types="helper" />',
      'declare module "node:fs" {',
      "  export function inspect(value: Helper): void;",
      "}",
      "",
    ].join("\n"),
    "interface Helper { readonly value: string; }\n",
    "@types/actual-helper",
  );
  const typesRoot = join(fixture.resolutionContext, "node_modules", "@types");
  await rename(join(typesRoot, "actual-helper"), join(typesRoot, "helper"));
  await writeJson(join(typesRoot, "node", "package.json"), {
    name: "@types/node",
    version: "95.0.0",
    types: "index.d.ts",
    dependencies: { [declaredDependency]: "npm:@types/actual-helper@1.0.0" },
  });
  if (layout === "pnpm") {
    await materializePnpmAliasLayout(fixture.resolutionContext);
  }
  return fixture;
}

export async function materializeWorkspaceTypeReferenceFixture(): Promise<NodeProviderFixture> {
  const packageName = "typepeek-workspace-type-helper";
  const fixture = await materializeNodeProviderFixture(
    [
      `/// <reference types="${packageName}" />`,
      'declare module "node:fs" {',
      "  export function inspect(value: Helper): void;",
      "}",
      "",
    ].join("\n"),
    "interface Helper { readonly value: string; }\n",
    packageName,
  );
  const logicalRoot = join(fixture.resolutionContext, "node_modules", packageName);
  const workspaceRoot = join(dirname(fixture.resolutionContext), "workspace-type-helper");
  await rename(logicalRoot, workspaceRoot);
  await symlink(relative(dirname(logicalRoot), workspaceRoot), logicalRoot, "dir");
  return fixture;
}

async function materializePnpmAliasLayout(resolutionContext: string): Promise<void> {
  const logicalRoot = join(resolutionContext, "node_modules", "@types", "helper");
  const physicalRoot = join(
    resolutionContext,
    "node_modules",
    ".pnpm",
    "@types+actual-helper@1.0.0",
    "node_modules",
    "@types",
    "actual-helper",
  );
  await mkdir(dirname(physicalRoot), { recursive: true });
  await rename(logicalRoot, physicalRoot);
  await symlink(relative(dirname(logicalRoot), physicalRoot), logicalRoot, "dir");
}

async function materializeOptionalHelper(
  fixtureRoot: string,
  tarballsRoot: string,
  npmCacheRoot: string,
  declaration: string | undefined,
  packageName: string,
  installation: "declared" | "nested-undeclared",
): Promise<string | undefined> {
  if (declaration === undefined || installation === "nested-undeclared") {
    return undefined;
  }
  const helperRoot = join(fixtureRoot, "helper");
  await writeHelperPackage(helperRoot, packageName, declaration);
  return packFixture(helperRoot, tarballsRoot, npmCacheRoot, "helper provider dependency");
}

async function installNestedHelper(
  resolutionContext: string,
  packageName: string,
  declaration: string,
): Promise<void> {
  const helperRoot = join(
    resolutionContext,
    "node_modules",
    "@types",
    "node",
    "node_modules",
    ...packageName.split("/"),
  );
  await writeHelperPackage(helperRoot, packageName, declaration);
}

async function writeHelperPackage(
  helperRoot: string,
  packageName: string,
  declaration: string,
): Promise<void> {
  await mkdir(helperRoot, { recursive: true });
  await Promise.all([
    writeJson(join(helperRoot, "package.json"), {
      name: packageName,
      version: "1.0.0",
      types: "index.d.ts",
    }),
    writeFile(join(helperRoot, "index.d.ts"), declaration),
  ]);
}

export async function materializeDeclarationProviderFixture(): Promise<DeclarationProviderFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek declaration providers-"));
  try {
    const sourcesRoot = join(fixtureRoot, "sources");
    const tarballsRoot = join(fixtureRoot, "tarballs");
    const npmCacheRoot = join(fixtureRoot, "npm-cache");
    const targetRoot = join(sourcesRoot, "target");
    const providerOneRoot = join(sourcesRoot, "provider-one");
    const providerTwoRoot = join(sourcesRoot, "provider-two");
    const injectedNodeProviderRoot = join(sourcesRoot, "node-provider-injected");
    const brokenNodeProviderRoot = join(sourcesRoot, "node-provider-broken");
    const brokenExportEqualsNodeProviderRoot = join(
      sourcesRoot,
      "node-provider-broken-export-equals",
    );
    const ambientProviderRoot = join(sourcesRoot, "provider-ambient");
    const exportedImportNodeProviderRoot = join(sourcesRoot, "node-provider-exported-import");
    await Promise.all([
      writeJavaScriptPackage(targetRoot),
      writeDeclarationProvider(providerOneRoot, "1.0.0", "provider-one"),
      writeDeclarationProvider(providerTwoRoot, "2.0.0", "provider-two"),
      writeNodeDeclarationProvider(
        injectedNodeProviderRoot,
        "99.0.0",
        'declare module "node:typepeek-not-real" { export const injected: string; }\n',
      ),
      writeNodeDeclarationProvider(
        brokenNodeProviderRoot,
        "98.0.0",
        'declare module "node:fs" { export * from "node:missing"; }\n',
      ),
      writeNodeDeclarationProvider(
        brokenExportEqualsNodeProviderRoot,
        "97.0.0",
        [
          'declare module "node:fs" {',
          '  import missing = require("node:missing");',
          "  export = missing;",
          "}",
          "",
        ].join("\n"),
      ),
      writeAmbientDeclarationProvider(ambientProviderRoot),
      writeNodeDeclarationProvider(
        exportedImportNodeProviderRoot,
        "96.0.0",
        [
          'declare module "node:fs" {',
          '  export import Missing = require("node:missing");',
          "}",
          "",
        ].join("\n"),
      ),
    ]);
    const [
      targetTarball,
      providerOneTarball,
      providerTwoTarball,
      injectedNodeProviderTarball,
      brokenNodeProviderTarball,
      brokenExportEqualsNodeProviderTarball,
      ambientProviderTarball,
      exportedImportNodeProviderTarball,
    ] = await Promise.all([
      packFixture(targetRoot, tarballsRoot, npmCacheRoot, "JavaScript target"),
      packFixture(providerOneRoot, tarballsRoot, npmCacheRoot, "provider one"),
      packFixture(providerTwoRoot, tarballsRoot, npmCacheRoot, "provider two"),
      packFixture(injectedNodeProviderRoot, tarballsRoot, npmCacheRoot, "injected node provider"),
      packFixture(brokenNodeProviderRoot, tarballsRoot, npmCacheRoot, "broken node provider"),
      packFixture(
        brokenExportEqualsNodeProviderRoot,
        tarballsRoot,
        npmCacheRoot,
        "broken export equals node provider",
      ),
      packFixture(ambientProviderRoot, tarballsRoot, npmCacheRoot, "ambient provider"),
      packFixture(
        exportedImportNodeProviderRoot,
        tarballsRoot,
        npmCacheRoot,
        "exported import node provider",
      ),
    ]);

    const providerOneContext = join(fixtureRoot, "contexts", "provider-one");
    const providerTwoContext = join(fixtureRoot, "contexts", "provider-two");
    const providerOnlyContext = join(fixtureRoot, "contexts", "provider-only");
    const missingProviderContext = join(fixtureRoot, "contexts", "missing-provider");
    const selfTypedWithMalformedProviderContext = join(
      fixtureRoot,
      "contexts",
      "self-typed-with-malformed-provider",
    );
    const injectedNodeProviderContext = join(fixtureRoot, "contexts", "node-provider-injected");
    const brokenNodeProviderContext = join(fixtureRoot, "contexts", "node-provider-broken");
    const brokenExportEqualsNodeProviderContext = join(
      fixtureRoot,
      "contexts",
      "node-provider-broken-export-equals",
    );
    const ambientProviderContext = join(fixtureRoot, "contexts", "provider-ambient");
    const nestedProviderContext = join(fixtureRoot, "contexts", "provider-nested-entrypoint");
    const exportedImportNodeProviderContext = join(
      fixtureRoot,
      "contexts",
      "node-provider-exported-import",
    );
    await installContext(
      providerOneContext,
      [targetTarball, providerOneTarball],
      npmCacheRoot,
      "provider one context",
    );
    await installContext(
      providerTwoContext,
      [targetTarball, providerTwoTarball],
      npmCacheRoot,
      "provider two context",
    );
    await installContext(
      missingProviderContext,
      [targetTarball],
      npmCacheRoot,
      "missing provider context",
    );
    await installContext(
      providerOnlyContext,
      [providerOneTarball],
      npmCacheRoot,
      "provider only context",
    );
    await installContext(
      selfTypedWithMalformedProviderContext,
      [targetTarball, providerOneTarball],
      npmCacheRoot,
      "self typed context",
    );
    await makeInstalledTargetSelfTyped(selfTypedWithMalformedProviderContext);
    await installContext(
      injectedNodeProviderContext,
      [injectedNodeProviderTarball],
      npmCacheRoot,
      "injected node provider context",
    );
    await installContext(
      brokenNodeProviderContext,
      [brokenNodeProviderTarball],
      npmCacheRoot,
      "broken node provider context",
    );
    await installContext(
      brokenExportEqualsNodeProviderContext,
      [brokenExportEqualsNodeProviderTarball],
      npmCacheRoot,
      "broken export equals node provider context",
    );
    await installContext(
      ambientProviderContext,
      [targetTarball, ambientProviderTarball],
      npmCacheRoot,
      "ambient provider context",
    );
    await installContext(
      nestedProviderContext,
      [targetTarball, providerOneTarball],
      npmCacheRoot,
      "nested provider context",
    );
    await makeInstalledProviderDelegateToNested(nestedProviderContext);
    await installContext(
      exportedImportNodeProviderContext,
      [exportedImportNodeProviderTarball],
      npmCacheRoot,
      "exported import node provider context",
    );

    return {
      ambientProviderContext,
      brokenExportEqualsNodeProviderContext,
      brokenNodeProviderContext,
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
      injectedNodeProviderContext,
      nestedProviderContext,
      exportedImportNodeProviderContext,
      missingProviderContext,
      packageName: PACKAGE_NAME,
      providerName: PROVIDER_NAME,
      providerOneContext,
      providerOnlyContext,
      selfTypedWithMalformedProviderContext,
      providerTwoContext,
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeAmbientDeclarationProvider(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeJson(join(packageRoot, "package.json"), {
      name: PROVIDER_NAME,
      version: "3.0.0",
      types: "index.d.ts",
    }),
    writeFile(
      join(packageRoot, "index.d.ts"),
      `declare module "${PACKAGE_NAME}" { export function ambient(value: string): string; }\n`,
    ),
  ]);
}

async function makeInstalledProviderDelegateToNested(resolutionContext: string): Promise<void> {
  const providerRoot = join(resolutionContext, "node_modules", "@types", PACKAGE_NAME);
  const nestedRoot = join(providerRoot, "node_modules", "inner-provider");
  await mkdir(nestedRoot, { recursive: true });
  await Promise.all([
    writeJson(join(providerRoot, "package.json"), {
      name: PROVIDER_NAME,
      version: "1.0.0",
      types: "node_modules/inner-provider/index.d.ts",
    }),
    writeJson(join(nestedRoot, "package.json"), {
      name: "inner-provider",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    writeFile(join(nestedRoot, "index.d.ts"), "export declare const nested: string;\n"),
  ]);
}

async function writeNodeDeclarationProvider(
  packageRoot: string,
  version: string,
  declaration: string,
  peerDependencies?: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeJson(join(packageRoot, "package.json"), {
      name: "@types/node",
      version,
      types: "index.d.ts",
      ...(peerDependencies === undefined ? {} : { peerDependencies }),
    }),
    writeFile(join(packageRoot, "index.d.ts"), declaration),
  ]);
}

async function makeInstalledTargetSelfTyped(resolutionContext: string): Promise<void> {
  const targetRoot = join(resolutionContext, "node_modules", PACKAGE_NAME);
  const providerRoot = join(resolutionContext, "node_modules", "@types", PACKAGE_NAME);
  await Promise.all([
    writeJson(join(targetRoot, "package.json"), {
      name: PACKAGE_NAME,
      version: "3.0.0",
      main: "index.js",
      types: "index.d.ts",
    }),
    writeFile(join(targetRoot, "index.d.ts"), 'export declare const selfOwned: "target";\n'),
    writeFile(join(providerRoot, "package.json"), "{ malformed provider manifest"),
  ]);
}

async function writeJavaScriptPackage(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeJson(join(packageRoot, "package.json"), {
      name: PACKAGE_NAME,
      version: "3.0.0",
      main: "index.js",
    }),
    writeFile(join(packageRoot, "index.js"), 'throw new Error("runtime must not execute");\n'),
  ]);
}

async function writeDeclarationProvider(
  packageRoot: string,
  version: string,
  visibleValue: string,
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeJson(join(packageRoot, "package.json"), {
      name: PROVIDER_NAME,
      version,
      types: "index.d.ts",
    }),
    writeFile(
      join(packageRoot, "index.d.ts"),
      [
        `export declare const providerVersion: "${visibleValue}";`,
        "export declare function overloaded(value: string): string;",
        "export declare function overloaded(value: number): number;",
        "",
      ].join("\n"),
    ),
  ]);
}

async function packFixture(
  packageRoot: string,
  tarballsRoot: string,
  npmCacheRoot: string,
  diagnosticContext: string,
): Promise<string> {
  return packPackage({ diagnosticContext, npmCacheRoot, packageRoot, tarballsRoot });
}

async function installContext(
  resolutionContext: string,
  packagePaths: readonly string[],
  npmCacheRoot: string,
  diagnosticContext: string,
): Promise<void> {
  await mkdir(resolutionContext, { recursive: true });
  await writeJson(join(resolutionContext, "package.json"), {
    name: `fixture-${diagnosticContext.replaceAll(" ", "-")}`,
    private: true,
  });
  await installPackedPackagesWithNpm({
    diagnosticContext,
    npmCacheRoot,
    packagePaths,
    resolutionContext,
  });
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await writeFile(fileName, JSON.stringify(value));
}
