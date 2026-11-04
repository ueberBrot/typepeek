import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { PackageManagerPin } from "./package-toolchain.ts";
import {
  installDeclaredPackages,
  localPackageSpecifier,
  PACKAGE_MANAGER_PINS,
  packPackage,
} from "./package-toolchain.ts";
import type { StaticInspection } from "./static-inspection.ts";
import { materializeStaticInspection } from "./static-inspection.ts";

const PACKAGE_MANIFEST_FILE = "package.json";

export interface PackageManagerInstallation {
  readonly installSentinel: string;
  readonly manager: "npm" | "pnpm" | "bun";
  readonly resolutionContext: string;
  readonly subjectIsSymlink: boolean;
  readonly subjectPhysicalPath: string;
  readonly version: string;
}

export interface PackageManagerMatrix {
  readonly installations: readonly PackageManagerInstallation[];
  readonly staticInspection: StaticInspection;
  readonly unsupportedInstallation: {
    readonly ancestorPackageSpecifier: string;
    readonly resolutionContext: string;
    readonly runtimeSentinel: string;
  };
  readonly cleanup: () => Promise<void>;
}

interface PackedFixturePackages {
  readonly repositoryNested: string;
  readonly subject: string;
}

const writeFixturePackage = async function writeFixturePackage(
  packageRoot: string,
  options: {
    readonly declaration: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly name: string;
    readonly scripts?: Readonly<Record<string, string>>;
    readonly version: string;
  }
): Promise<void> {
  const distRoot = nodePath.join(packageRoot, "dist");
  await mkdir(distRoot, { recursive: true });
  // The nested manifest is a module scope, not a Package Identity.
  await Promise.all([
    writeFile(
      nodePath.join(packageRoot, PACKAGE_MANIFEST_FILE),
      JSON.stringify({
        exports: {
          ".": Object.fromEntries([
            ["types", "./dist/index.d.ts"],
            ["import", "./dist/index.js"],
          ]),
        },
        files: ["dist"],
        name: options.name,
        type: "module",
        version: options.version,
        ...(options.dependencies !== undefined && {
          dependencies: options.dependencies,
        }),
        ...(options.scripts !== undefined && { scripts: options.scripts }),
      })
    ),
    writeFile(nodePath.join(distRoot, "index.d.ts"), options.declaration),
    writeFile(
      nodePath.join(distRoot, "index.js"),
      'throw new Error("fixture runtime executed");\n'
    ),
    writeFile(
      nodePath.join(distRoot, PACKAGE_MANIFEST_FILE),
      JSON.stringify({ type: "module" })
    ),
  ]);
};

const packFixturePackages = async function packFixturePackages(
  fixtureRoot: string,
  npmCacheRoot: string
): Promise<PackedFixturePackages> {
  const sourcesRoot = nodePath.join(fixtureRoot, "sources");
  const tarballsRoot = nodePath.join(fixtureRoot, "tarballs");
  const subjectNestedRoot = nodePath.join(sourcesRoot, "subject-nested");
  const repositoryNestedRoot = nodePath.join(sourcesRoot, "repository-nested");
  const subjectRoot = nodePath.join(sourcesRoot, "layout-subject");
  await mkdir(tarballsRoot, { recursive: true });
  await Promise.all([
    writeFixturePackage(subjectNestedRoot, {
      declaration: 'export declare const nestedValue: "subject-nested";\n',
      name: "@typepeek-fixture/nested",
      version: "1.0.0",
    }),
    writeFixturePackage(repositoryNestedRoot, {
      declaration: 'export declare const nestedValue: "repository-nested";\n',
      name: "@typepeek-fixture/nested",
      version: "2.0.0",
    }),
  ]);

  const subjectNested = await packPackage({
    diagnosticContext: "subject nested Package Module fixture",
    npmCacheRoot,
    packageRoot: subjectNestedRoot,
    tarballsRoot,
  });

  const repositoryNested = await packPackage({
    diagnosticContext: "repository nested Package Module fixture",
    npmCacheRoot,
    packageRoot: repositoryNestedRoot,
    tarballsRoot,
  });

  // The repository installs another version; the subject must resolve its own declared dependency.
  await writeFixturePackage(subjectRoot, {
    declaration: [
      'export { nestedValue } from "@typepeek-fixture/nested";',
      'export declare const subjectValue: "subject";',
      "",
    ].join("\n"),
    dependencies: {
      "@typepeek-fixture/nested": localPackageSpecifier(subjectNested),
    },
    name: "@typepeek-fixture/layout-subject",
    scripts: {
      postinstall:
        "node -e \"require('node:fs').writeFileSync('INSTALL_SCRIPT_EXECUTED', 'executed')\"",
    },
    version: "1.0.0",
  });

  return {
    repositoryNested,
    subject: await packPackage({
      diagnosticContext: "layout subject Package Module fixture",
      npmCacheRoot,
      packageRoot: subjectRoot,
      tarballsRoot,
    }),
  };
};

const materializeInstallation = async function materializeInstallation(
  fixtureRoot: string,
  packages: PackedFixturePackages,
  packageManager: PackageManagerPin
): Promise<PackageManagerInstallation> {
  const resolutionContext = nodePath.join(
    fixtureRoot,
    "repositories",
    packageManager.manager
  );

  await mkdir(resolutionContext, { recursive: true });
  await writeFile(
    nodePath.join(resolutionContext, PACKAGE_MANIFEST_FILE),
    JSON.stringify({
      dependencies: {
        "@typepeek-fixture/layout-subject": localPackageSpecifier(
          packages.subject
        ),
        "@typepeek-fixture/nested": localPackageSpecifier(
          packages.repositoryNested
        ),
      },
      name: `fixture-${packageManager.manager}-repository`,
      private: true,
    })
  );

  const version = await installDeclaredPackages({
    cacheRoot: fixtureRoot,
    diagnosticContext: `${packageManager.manager} Supported Installation in Resolution Context ${resolutionContext}`,
    offline: true,
    packageManager,
    resolutionContext,
  });

  const subjectRoot = nodePath.join(
    resolutionContext,
    "node_modules",
    "@typepeek-fixture",
    "layout-subject"
  );

  const lstatResult = await lstat(subjectRoot);

  return {
    installSentinel: nodePath.join(subjectRoot, "INSTALL_SCRIPT_EXECUTED"),
    manager: packageManager.manager,
    resolutionContext,
    subjectIsSymlink: lstatResult.isSymbolicLink(),
    subjectPhysicalPath: await realpath(subjectRoot),
    version,
  };
};

const materializeUnsupportedInstallation =
  async function materializeUnsupportedInstallation(
    fixtureRoot: string
  ): Promise<{
    readonly ancestorPackageSpecifier: string;
    readonly resolutionContext: string;
    readonly runtimeSentinel: string;
  }> {
    const ancestorPackageSpecifier = "@typepeek-fixture/ancestor-only";

    const resolutionContext = nodePath.join(
      fixtureRoot,
      "repositories",
      "unsupported-pnp"
    );

    const runtimeSentinel = nodePath.join(
      resolutionContext,
      "PNP_RUNTIME_EXECUTED"
    );

    const ancestorPackageRoot = nodePath.join(
      nodePath.dirname(resolutionContext),
      "node_modules",
      ...ancestorPackageSpecifier.split("/")
    );

    await Promise.all([
      mkdir(resolutionContext, { recursive: true }),
      mkdir(nodePath.join(ancestorPackageRoot, "dist"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        nodePath.join(resolutionContext, PACKAGE_MANIFEST_FILE),
        JSON.stringify({
          dependencies: { "@typepeek-fixture/layout-subject": "1.0.0" },
          name: "fixture-unsupported-repository",
          private: true,
        })
      ),
      writeFile(
        nodePath.join(resolutionContext, ".pnp.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(runtimeSentinel)}, "executed");\n`
      ),
      writeFile(
        nodePath.join(ancestorPackageRoot, PACKAGE_MANIFEST_FILE),
        JSON.stringify({
          name: ancestorPackageSpecifier,
          types: "./dist/index.d.ts",
          version: "1.0.0",
        })
      ),
      writeFile(
        nodePath.join(ancestorPackageRoot, "dist", "index.d.ts"),
        "export declare const ancestorOnly: string;\n"
      ),
    ]);

    return { ancestorPackageSpecifier, resolutionContext, runtimeSentinel };
  };

export const materializePackageManagerMatrix =
  async function materializePackageManagerMatrix(): Promise<PackageManagerMatrix> {
    // The space catches file-spec path encoding bugs.
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek package-manager matrix-")
    );

    try {
      const npmCacheRoot = nodePath.join(fixtureRoot, "npm-cache");
      const packages = await packFixturePackages(fixtureRoot, npmCacheRoot);
      const installations: PackageManagerInstallation[] = [];

      await Array.fromAsync(PACKAGE_MANAGER_PINS, async (packageManager) => {
        installations.push(
          await materializeInstallation(fixtureRoot, packages, packageManager)
        );
      });

      const staticInspection = await materializeStaticInspection(fixtureRoot);

      const unsupportedInstallation =
        await materializeUnsupportedInstallation(fixtureRoot);

      return {
        cleanup: async () => {
          await rm(fixtureRoot, { force: true, recursive: true });
        },
        installations,
        staticInspection,
        unsupportedInstallation,
      };
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
  };
