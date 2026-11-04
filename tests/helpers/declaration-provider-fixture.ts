import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { Schema } from "effect";

import {
  installPackedPackagesWithNpm,
  packPackage,
} from "./package-toolchain.ts";

const PACKAGE_MANIFEST_FILE = "package.json";
const DECLARATION_ENTRY_FILE = "index.d.ts";
const NESTED_UNDECLARED = "nested-undeclared";
const FS_MODULE_DECLARATION = 'declare module "node:fs" {';
const PROVIDER_ONE = "provider-one";
const PROVIDER_TWO = "provider-two";

const PACKAGE_NAME = "typepeek-provider-target";
const PROVIDER_NAME = "@types/typepeek-provider-target";

export interface DeclarationProviderFixture {
  readonly ambientProviderContext: string;
  readonly brokenExportEqualsNodeProviderContext: string;
  readonly brokenNodeProviderContext: string;
  readonly hoistedProviderContext: string;
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

const writeJson = async function writeJson(
  fileName: string,
  value: Schema.Json
): Promise<void> {
  await writeFile(fileName, JSON.stringify(value));
};

const writeNodeDeclarationProvider =
  async function writeNodeDeclarationProvider(
    packageRoot: string,
    version: string,
    declaration: string,
    peerDependencies?: Readonly<Record<string, string>>
  ): Promise<void> {
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
        name: "@types/node",
        types: DECLARATION_ENTRY_FILE,
        version,
        ...(peerDependencies !== undefined && { peerDependencies }),
      }),
      writeFile(
        nodePath.join(packageRoot, DECLARATION_ENTRY_FILE),
        declaration
      ),
    ]);
  };

const packFixture = async function packFixture(
  packageRoot: string,
  tarballsRoot: string,
  npmCacheRoot: string,
  diagnosticContext: string
): Promise<string> {
  return await packPackage({
    diagnosticContext,
    npmCacheRoot,
    packageRoot,
    tarballsRoot,
  });
};

const writeHelperPackage = async function writeHelperPackage(
  helperRoot: string,
  packageName: string,
  declaration: string
): Promise<void> {
  await mkdir(helperRoot, { recursive: true });
  await Promise.all([
    writeJson(nodePath.join(helperRoot, PACKAGE_MANIFEST_FILE), {
      name: packageName,
      types: DECLARATION_ENTRY_FILE,
      version: "1.0.0",
    }),
    writeFile(nodePath.join(helperRoot, DECLARATION_ENTRY_FILE), declaration),
  ]);
};

const materializeOptionalHelper = async function materializeOptionalHelper(
  fixtureRoot: string,
  tarballsRoot: string,
  npmCacheRoot: string,
  declaration: string | undefined,
  packageName: string,
  installation: "declared" | "nested-undeclared"
): Promise<string | undefined> {
  if (declaration === undefined || installation === NESTED_UNDECLARED) {
    return undefined;
  }

  const helperRoot = nodePath.join(fixtureRoot, "helper");
  await writeHelperPackage(helperRoot, packageName, declaration);

  return await packFixture(
    helperRoot,
    tarballsRoot,
    npmCacheRoot,
    "helper provider dependency"
  );
};

const installContext = async function installContext(
  resolutionContext: string,
  packagePaths: readonly string[],
  npmCacheRoot: string,
  diagnosticContext: string
): Promise<void> {
  await mkdir(resolutionContext, { recursive: true });
  await writeJson(nodePath.join(resolutionContext, PACKAGE_MANIFEST_FILE), {
    name: `fixture-${diagnosticContext.replaceAll(" ", "-")}`,
    private: true,
  });
  await installPackedPackagesWithNpm({
    diagnosticContext,
    npmCacheRoot,
    packagePaths,
    resolutionContext,
  });
};

const installNestedHelper = async function installNestedHelper(
  resolutionContext: string,
  packageName: string,
  declaration: string
): Promise<void> {
  const helperRoot = nodePath.join(
    resolutionContext,
    "node_modules",
    "@types",
    "node",
    "node_modules",
    ...packageName.split("/")
  );

  await writeHelperPackage(helperRoot, packageName, declaration);
};

export const materializeNodeProviderFixture =
  async function materializeNodeProviderFixture(
    declaration: string,
    helperDeclaration?: string,
    helperPackageName = "helper",
    helperInstallation: "declared" | "nested-undeclared" = "declared"
  ): Promise<NodeProviderFixture> {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek node provider-")
    );

    try {
      const providerRoot = nodePath.join(fixtureRoot, "provider");
      const tarballsRoot = nodePath.join(fixtureRoot, "tarballs");
      const npmCacheRoot = nodePath.join(fixtureRoot, "npm-cache");
      const resolutionContext = nodePath.join(fixtureRoot, "context");
      await writeNodeDeclarationProvider(
        providerRoot,
        "95.0.0",
        declaration,
        helperDeclaration === undefined ||
          helperInstallation === NESTED_UNDECLARED
          ? undefined
          : { [helperPackageName]: "*" }
      );

      const providerTarball = await packFixture(
        providerRoot,
        tarballsRoot,
        npmCacheRoot,
        "single node provider"
      );

      const helperTarball = await materializeOptionalHelper(
        fixtureRoot,
        tarballsRoot,
        npmCacheRoot,
        helperDeclaration,
        helperPackageName,
        helperInstallation
      );

      await installContext(
        resolutionContext,
        helperTarball === undefined
          ? [providerTarball]
          : [providerTarball, helperTarball],
        npmCacheRoot,
        "single node provider context"
      );

      if (
        helperDeclaration !== undefined &&
        helperInstallation === NESTED_UNDECLARED
      ) {
        await installNestedHelper(
          resolutionContext,
          helperPackageName,
          helperDeclaration
        );
      }

      return {
        cleanup: async () => {
          await rm(fixtureRoot, { force: true, recursive: true });
        },
        resolutionContext,
      };
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
  };

const materializePnpmAliasLayout = async function materializePnpmAliasLayout(
  resolutionContext: string
): Promise<void> {
  const logicalRoot = nodePath.join(
    resolutionContext,
    "node_modules",
    "@types",
    "helper"
  );

  const physicalRoot = nodePath.join(
    resolutionContext,
    "node_modules",
    ".pnpm",
    "@types+actual-helper@1.0.0",
    "node_modules",
    "@types",
    "actual-helper"
  );

  await mkdir(nodePath.dirname(physicalRoot), { recursive: true });
  await rename(logicalRoot, physicalRoot);
  await symlink(
    nodePath.relative(nodePath.dirname(logicalRoot), physicalRoot),
    logicalRoot,
    "dir"
  );
};

export const materializeAliasedTypeReferenceFixture =
  async function materializeAliasedTypeReferenceFixture(
    declaredDependency: "@types/helper" | "@types/actual-helper",
    layout: "npm" | "pnpm" = "npm"
  ): Promise<NodeProviderFixture> {
    const fixture = await materializeNodeProviderFixture(
      [
        '/// <reference types="helper" />',
        FS_MODULE_DECLARATION,
        "  export function inspect(value: Helper): void;",
        "}",
        "",
      ].join("\n"),
      "interface Helper { readonly value: string; }\n",
      "@types/actual-helper"
    );

    const typesRoot = nodePath.join(
      fixture.resolutionContext,
      "node_modules",
      "@types"
    );

    await rename(
      nodePath.join(typesRoot, "actual-helper"),
      nodePath.join(typesRoot, "helper")
    );
    await writeJson(nodePath.join(typesRoot, "node", PACKAGE_MANIFEST_FILE), {
      dependencies: { [declaredDependency]: "npm:@types/actual-helper@1.0.0" },
      name: "@types/node",
      types: DECLARATION_ENTRY_FILE,
      version: "95.0.0",
    });

    if (layout === "pnpm") {
      await materializePnpmAliasLayout(fixture.resolutionContext);
    }

    return fixture;
  };

export const materializeWorkspaceTypeReferenceFixture =
  async function materializeWorkspaceTypeReferenceFixture(): Promise<NodeProviderFixture> {
    const packageName = "typepeek-workspace-type-helper";

    const fixture = await materializeNodeProviderFixture(
      [
        `/// <reference types="${packageName}" />`,
        FS_MODULE_DECLARATION,
        "  export function inspect(value: Helper): void;",
        "}",
        "",
      ].join("\n"),
      "interface Helper { readonly value: string; }\n",
      packageName
    );

    const logicalRoot = nodePath.join(
      fixture.resolutionContext,
      "node_modules",
      packageName
    );

    const workspaceRoot = nodePath.join(
      nodePath.dirname(fixture.resolutionContext),
      "workspace-type-helper"
    );

    await rename(logicalRoot, workspaceRoot);
    await symlink(
      nodePath.relative(nodePath.dirname(logicalRoot), workspaceRoot),
      logicalRoot,
      "dir"
    );

    return fixture;
  };

const writeJavaScriptPackage = async function writeJavaScriptPackage(
  packageRoot: string
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
      main: "index.js",
      name: PACKAGE_NAME,
      version: "3.0.0",
    }),
    writeFile(
      nodePath.join(packageRoot, "index.js"),
      'throw new Error("runtime must not execute");\n'
    ),
  ]);
};

const writeDeclarationProvider = async function writeDeclarationProvider(
  packageRoot: string,
  version: string,
  visibleValue: string
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
      name: PROVIDER_NAME,
      types: DECLARATION_ENTRY_FILE,
      version,
    }),
    writeFile(
      nodePath.join(packageRoot, DECLARATION_ENTRY_FILE),
      [
        `export declare const providerVersion: "${visibleValue}";`,
        "export declare function overloaded(value: string): string;",
        "export declare function overloaded(value: number): number;",
        "",
      ].join("\n")
    ),
  ]);
};

const writeAmbientDeclarationProvider =
  async function writeAmbientDeclarationProvider(
    packageRoot: string
  ): Promise<void> {
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeJson(nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE), {
        name: PROVIDER_NAME,
        types: DECLARATION_ENTRY_FILE,
        version: "3.0.0",
      }),
      writeFile(
        nodePath.join(packageRoot, DECLARATION_ENTRY_FILE),
        `declare module "${PACKAGE_NAME}" { export function ambient(value: string): string; }\n`
      ),
    ]);
  };

const makeInstalledTargetSelfTyped =
  async function makeInstalledTargetSelfTyped(
    resolutionContext: string
  ): Promise<void> {
    const targetRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      PACKAGE_NAME
    );

    const providerRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      "@types",
      PACKAGE_NAME
    );

    await Promise.all([
      writeJson(nodePath.join(targetRoot, PACKAGE_MANIFEST_FILE), {
        main: "index.js",
        name: PACKAGE_NAME,
        types: DECLARATION_ENTRY_FILE,
        version: "3.0.0",
      }),
      writeFile(
        nodePath.join(targetRoot, DECLARATION_ENTRY_FILE),
        'export declare const selfOwned: "target";\n'
      ),
      writeFile(
        nodePath.join(providerRoot, PACKAGE_MANIFEST_FILE),
        "{ malformed provider manifest"
      ),
    ]);
  };

const makeInstalledProviderDelegateToNested =
  async function makeInstalledProviderDelegateToNested(
    resolutionContext: string
  ): Promise<void> {
    const providerRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      "@types",
      PACKAGE_NAME
    );

    const nestedRoot = nodePath.join(
      providerRoot,
      "node_modules",
      "inner-provider"
    );

    await mkdir(nestedRoot, { recursive: true });
    await Promise.all([
      writeJson(nodePath.join(providerRoot, PACKAGE_MANIFEST_FILE), {
        name: PROVIDER_NAME,
        types: "node_modules/inner-provider/index.d.ts",
        version: "1.0.0",
      }),
      writeJson(nodePath.join(nestedRoot, PACKAGE_MANIFEST_FILE), {
        name: "inner-provider",
        types: DECLARATION_ENTRY_FILE,
        version: "1.0.0",
      }),
      writeFile(
        nodePath.join(nestedRoot, DECLARATION_ENTRY_FILE),
        "export declare const nested: string;\n"
      ),
    ]);
  };

export const materializeDeclarationProviderFixture =
  async function materializeDeclarationProviderFixture(): Promise<DeclarationProviderFixture> {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek declaration providers-")
    );

    try {
      const sourcesRoot = nodePath.join(fixtureRoot, "sources");
      const tarballsRoot = nodePath.join(fixtureRoot, "tarballs");
      const npmCacheRoot = nodePath.join(fixtureRoot, "npm-cache");
      const targetRoot = nodePath.join(sourcesRoot, "target");
      const providerOneRoot = nodePath.join(sourcesRoot, PROVIDER_ONE);
      const providerTwoRoot = nodePath.join(sourcesRoot, PROVIDER_TWO);

      const injectedNodeProviderRoot = nodePath.join(
        sourcesRoot,
        "node-provider-injected"
      );

      const brokenNodeProviderRoot = nodePath.join(
        sourcesRoot,
        "node-provider-broken"
      );

      const brokenExportEqualsNodeProviderRoot = nodePath.join(
        sourcesRoot,
        "node-provider-broken-export-equals"
      );

      const ambientProviderRoot = nodePath.join(
        sourcesRoot,
        "provider-ambient"
      );

      const exportedImportNodeProviderRoot = nodePath.join(
        sourcesRoot,
        "node-provider-exported-import"
      );

      await Promise.all([
        writeJavaScriptPackage(targetRoot),
        writeDeclarationProvider(providerOneRoot, "1.0.0", PROVIDER_ONE),
        writeDeclarationProvider(providerTwoRoot, "2.0.0", PROVIDER_TWO),
        writeNodeDeclarationProvider(
          injectedNodeProviderRoot,
          "99.0.0",
          'declare module "node:typepeek-not-real" { export const injected: string; }\n'
        ),
        writeNodeDeclarationProvider(
          brokenNodeProviderRoot,
          "98.0.0",
          'declare module "node:fs" { export * from "node:missing"; }\n'
        ),
        writeNodeDeclarationProvider(
          brokenExportEqualsNodeProviderRoot,
          "97.0.0",
          [
            FS_MODULE_DECLARATION,
            '  import missing = require("node:missing");',
            "  export = missing;",
            "}",
            "",
          ].join("\n")
        ),
        writeAmbientDeclarationProvider(ambientProviderRoot),
        writeNodeDeclarationProvider(
          exportedImportNodeProviderRoot,
          "96.0.0",
          [
            FS_MODULE_DECLARATION,
            '  export import Missing = require("node:missing");',
            "}",
            "",
          ].join("\n")
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
        packFixture(
          targetRoot,
          tarballsRoot,
          npmCacheRoot,
          "JavaScript target"
        ),
        packFixture(
          providerOneRoot,
          tarballsRoot,
          npmCacheRoot,
          "provider one"
        ),
        packFixture(
          providerTwoRoot,
          tarballsRoot,
          npmCacheRoot,
          "provider two"
        ),
        packFixture(
          injectedNodeProviderRoot,
          tarballsRoot,
          npmCacheRoot,
          "injected node provider"
        ),
        packFixture(
          brokenNodeProviderRoot,
          tarballsRoot,
          npmCacheRoot,
          "broken node provider"
        ),
        packFixture(
          brokenExportEqualsNodeProviderRoot,
          tarballsRoot,
          npmCacheRoot,
          "broken export equals node provider"
        ),
        packFixture(
          ambientProviderRoot,
          tarballsRoot,
          npmCacheRoot,
          "ambient provider"
        ),
        packFixture(
          exportedImportNodeProviderRoot,
          tarballsRoot,
          npmCacheRoot,
          "exported import node provider"
        ),
      ]);

      const providerOneContext = nodePath.join(
        fixtureRoot,
        "contexts",
        PROVIDER_ONE
      );

      const hoistedProviderContext = nodePath.join(
        providerOneContext,
        "workspace"
      );

      const providerTwoContext = nodePath.join(
        fixtureRoot,
        "contexts",
        PROVIDER_TWO
      );

      const providerOnlyContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "provider-only"
      );

      const missingProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "missing-provider"
      );

      const selfTypedWithMalformedProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "self-typed-with-malformed-provider"
      );

      const injectedNodeProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "node-provider-injected"
      );

      const brokenNodeProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "node-provider-broken"
      );

      const brokenExportEqualsNodeProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "node-provider-broken-export-equals"
      );

      const ambientProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "provider-ambient"
      );

      const nestedProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "provider-nested-entrypoint"
      );

      const exportedImportNodeProviderContext = nodePath.join(
        fixtureRoot,
        "contexts",
        "node-provider-exported-import"
      );

      await installContext(
        providerOneContext,
        [targetTarball, providerOneTarball],
        npmCacheRoot,
        "provider one context"
      );
      await mkdir(hoistedProviderContext);
      await writeJson(
        nodePath.join(hoistedProviderContext, PACKAGE_MANIFEST_FILE),
        {
          name: "fixture-hoisted-provider-workspace",
          private: true,
        }
      );
      await installContext(
        providerTwoContext,
        [targetTarball, providerTwoTarball],
        npmCacheRoot,
        "provider two context"
      );
      await installContext(
        missingProviderContext,
        [targetTarball],
        npmCacheRoot,
        "missing provider context"
      );
      await installContext(
        providerOnlyContext,
        [providerOneTarball],
        npmCacheRoot,
        "provider only context"
      );
      await installContext(
        selfTypedWithMalformedProviderContext,
        [targetTarball, providerOneTarball],
        npmCacheRoot,
        "self typed context"
      );
      await makeInstalledTargetSelfTyped(selfTypedWithMalformedProviderContext);
      await installContext(
        injectedNodeProviderContext,
        [injectedNodeProviderTarball],
        npmCacheRoot,
        "injected node provider context"
      );
      await installContext(
        brokenNodeProviderContext,
        [brokenNodeProviderTarball],
        npmCacheRoot,
        "broken node provider context"
      );
      await installContext(
        brokenExportEqualsNodeProviderContext,
        [brokenExportEqualsNodeProviderTarball],
        npmCacheRoot,
        "broken export equals node provider context"
      );
      await installContext(
        ambientProviderContext,
        [targetTarball, ambientProviderTarball],
        npmCacheRoot,
        "ambient provider context"
      );
      await installContext(
        nestedProviderContext,
        [targetTarball, providerOneTarball],
        npmCacheRoot,
        "nested provider context"
      );
      await makeInstalledProviderDelegateToNested(nestedProviderContext);
      await installContext(
        exportedImportNodeProviderContext,
        [exportedImportNodeProviderTarball],
        npmCacheRoot,
        "exported import node provider context"
      );

      return {
        ambientProviderContext,
        brokenExportEqualsNodeProviderContext,
        brokenNodeProviderContext,
        cleanup: async () => {
          await rm(fixtureRoot, { force: true, recursive: true });
        },
        exportedImportNodeProviderContext,
        hoistedProviderContext,
        injectedNodeProviderContext,
        missingProviderContext,
        nestedProviderContext,
        packageName: PACKAGE_NAME,
        providerName: PROVIDER_NAME,
        providerOneContext,
        providerOnlyContext,
        providerTwoContext,
        selfTypedWithMalformedProviderContext,
      };
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
  };
