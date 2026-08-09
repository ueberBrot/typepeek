import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installDeclaredPackages,
  localPackageSpecifier,
  type PackageManagerPin,
  PACKAGE_MANAGER_PINS,
  packPackage,
} from "./package-toolchain.ts";
import { materializeStaticInspection, type StaticInspection } from "./static-inspection.ts";

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
    readonly resolutionContext: string;
    readonly runtimeSentinel: string;
  };
  readonly cleanup: () => Promise<void>;
}

interface PackedFixturePackages {
  readonly nestedVersionTwo: string;
  readonly subject: string;
}

export async function materializePackageManagerMatrix(): Promise<PackageManagerMatrix> {
  // The space catches file-spec path encoding bugs.
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek package-manager matrix-"));

  try {
    const npmCacheRoot = join(fixtureRoot, "npm-cache");
    const packages = await packFixturePackages(fixtureRoot, npmCacheRoot);
    const installations = [];

    for (const packageManager of PACKAGE_MANAGER_PINS) {
      installations.push(await materializeInstallation(fixtureRoot, packages, packageManager));
    }
    const staticInspection = await materializeStaticInspection(fixtureRoot);
    const unsupportedInstallation = await materializeUnsupportedInstallation(fixtureRoot);

    return {
      installations,
      staticInspection,
      unsupportedInstallation,
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function materializeUnsupportedInstallation(fixtureRoot: string): Promise<{
  readonly resolutionContext: string;
  readonly runtimeSentinel: string;
}> {
  const resolutionContext = join(fixtureRoot, "repositories", "unsupported-pnp");
  const runtimeSentinel = join(resolutionContext, "PNP_RUNTIME_EXECUTED");
  await mkdir(resolutionContext, { recursive: true });
  await Promise.all([
    writeFile(
      join(resolutionContext, "package.json"),
      JSON.stringify({
        name: "fixture-unsupported-repository",
        private: true,
        dependencies: { "@typepeek-fixture/layout-subject": "1.0.0" },
      }),
    ),
    writeFile(
      join(resolutionContext, ".pnp.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(runtimeSentinel)}, "executed");\n`,
    ),
  ]);
  return { resolutionContext, runtimeSentinel };
}

async function packFixturePackages(
  fixtureRoot: string,
  npmCacheRoot: string,
): Promise<PackedFixturePackages> {
  const sourcesRoot = join(fixtureRoot, "sources");
  const tarballsRoot = join(fixtureRoot, "tarballs");
  const nestedVersionOneRoot = join(sourcesRoot, "nested-v1");
  const nestedVersionTwoRoot = join(sourcesRoot, "nested-v2");
  const subjectRoot = join(sourcesRoot, "layout-subject");
  await mkdir(tarballsRoot, { recursive: true });

  await Promise.all([
    writeFixturePackage(nestedVersionOneRoot, {
      name: "@typepeek-fixture/nested",
      version: "1.0.0",
      declaration: 'export declare const nestedValue: "nested-v1";\n',
    }),
    writeFixturePackage(nestedVersionTwoRoot, {
      name: "@typepeek-fixture/nested",
      version: "2.0.0",
      declaration: 'export declare const nestedValue: "nested-v2";\n',
    }),
  ]);

  const nestedVersionOne = await packPackage({
    diagnosticContext: "nested v1 Package Module fixture",
    npmCacheRoot,
    packageRoot: nestedVersionOneRoot,
    tarballsRoot,
  });
  const nestedVersionTwo = await packPackage({
    diagnosticContext: "nested v2 Package Module fixture",
    npmCacheRoot,
    packageRoot: nestedVersionTwoRoot,
    tarballsRoot,
  });
  // The root installs v2; the subject must resolve its nested v1.
  await writeFixturePackage(subjectRoot, {
    name: "@typepeek-fixture/layout-subject",
    version: "1.0.0",
    declaration: [
      'export { nestedValue } from "@typepeek-fixture/nested";',
      'export declare const subjectValue: "subject";',
      "",
    ].join("\n"),
    dependencies: {
      "@typepeek-fixture/nested": localPackageSpecifier(nestedVersionOne),
    },
    scripts: {
      postinstall:
        "node -e \"require('node:fs').writeFileSync('INSTALL_SCRIPT_EXECUTED', 'executed')\"",
    },
  });

  return {
    nestedVersionTwo,
    subject: await packPackage({
      diagnosticContext: "layout subject Package Module fixture",
      npmCacheRoot,
      packageRoot: subjectRoot,
      tarballsRoot,
    }),
  };
}

async function writeFixturePackage(
  packageRoot: string,
  options: {
    readonly declaration: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly name: string;
    readonly scripts?: Readonly<Record<string, string>>;
    readonly version: string;
  },
): Promise<void> {
  const distRoot = join(packageRoot, "dist");
  await mkdir(distRoot, { recursive: true });
  // The nested manifest is a module scope, not a Package Identity.
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: options.name,
        version: options.version,
        type: "module",
        files: ["dist"],
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
        ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
        ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
      }),
    ),
    writeFile(join(distRoot, "index.d.ts"), options.declaration),
    writeFile(join(distRoot, "index.js"), 'throw new Error("fixture runtime executed");\n'),
    writeFile(join(distRoot, "package.json"), JSON.stringify({ type: "module" })),
  ]);
}

async function materializeInstallation(
  fixtureRoot: string,
  packages: PackedFixturePackages,
  packageManager: PackageManagerPin,
): Promise<PackageManagerInstallation> {
  const resolutionContext = join(fixtureRoot, "repositories", packageManager.manager);
  await mkdir(resolutionContext, { recursive: true });
  await writeFile(
    join(resolutionContext, "package.json"),
    JSON.stringify({
      name: `fixture-${packageManager.manager}-repository`,
      private: true,
      dependencies: {
        "@typepeek-fixture/layout-subject": localPackageSpecifier(packages.subject),
        "@typepeek-fixture/nested": localPackageSpecifier(packages.nestedVersionTwo),
      },
    }),
  );

  const version = await installDeclaredPackages({
    cacheRoot: fixtureRoot,
    diagnosticContext: `${packageManager.manager} Supported Installation in Resolution Context ${resolutionContext}`,
    offline: true,
    packageManager,
    resolutionContext,
  });
  const subjectRoot = join(
    resolutionContext,
    "node_modules",
    "@typepeek-fixture",
    "layout-subject",
  );
  return {
    installSentinel: join(subjectRoot, "INSTALL_SCRIPT_EXECUTED"),
    manager: packageManager.manager,
    resolutionContext,
    subjectIsSymlink: (await lstat(subjectRoot)).isSymbolicLink(),
    subjectPhysicalPath: await realpath(subjectRoot),
    version,
  };
}
