import { execa } from "execa";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

export const PACKAGE_MANAGER_PINS = [
  { command: "npm", manager: "npm", version: "11.16.0" },
  { command: "pnpm", manager: "pnpm", version: "11.20.0" },
  { command: "bun", manager: "bun", version: "1.3.14" },
] as const;

type PackageManager = (typeof PACKAGE_MANAGER_PINS)[number];

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
  readonly inspectionTripwire: {
    readonly preloadPath: string;
    readonly sentinel: string;
  };
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
      installations.push(
        await materializeInstallation(fixtureRoot, npmCacheRoot, packages, packageManager),
      );
    }
    const inspectionTripwire = await materializeInspectionTripwire(fixtureRoot);
    const unsupportedInstallation = await materializeUnsupportedInstallation(fixtureRoot);

    return {
      installations,
      inspectionTripwire,
      unsupportedInstallation,
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function materializeInspectionTripwire(fixtureRoot: string): Promise<{
  readonly preloadPath: string;
  readonly sentinel: string;
}> {
  const preloadPath = join(fixtureRoot, "inspection-tripwire.cjs");
  const sentinel = join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
  // Preload in the CLI and worker; fail on process or network I/O.
  await writeFile(
    preloadPath,
    [
      'const { writeFileSync } = require("node:fs");',
      'const { syncBuiltinESMExports } = require("node:module");',
      "const trip = () => {",
      '  writeFileSync(process.env.TYPEPEEK_IO_SENTINEL, "attempted");',
      '  throw new Error("Inspection attempted process or network activity");',
      "};",
      "for (const [moduleName, methods] of Object.entries({",
      '  "node:child_process": ["exec", "execFile", "fork", "spawn", "execSync", "execFileSync", "spawnSync"],',
      '  "node:dgram": ["createSocket"],',
      '  "node:dns": ["lookup", "resolve", "resolve4", "resolve6"],',
      '  "node:http": ["get", "request"],',
      '  "node:https": ["get", "request"],',
      '  "node:net": ["connect", "createConnection"],',
      '  "node:tls": ["connect"],',
      "})) {",
      "  const module = require(moduleName);",
      "  for (const method of methods) module[method] = trip;",
      "}",
      "globalThis.fetch = trip;",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return { preloadPath, sentinel };
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

  const nestedVersionOne = await packPackage(nestedVersionOneRoot, tarballsRoot, npmCacheRoot);
  const nestedVersionTwo = await packPackage(nestedVersionTwoRoot, tarballsRoot, npmCacheRoot);
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
    subject: await packPackage(subjectRoot, tarballsRoot, npmCacheRoot),
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

async function packPackage(
  packageRoot: string,
  tarballsRoot: string,
  npmCacheRoot: string,
): Promise<string> {
  const packed = await execa(
    "npm",
    ["pack", "--json", "--pack-destination", tarballsRoot, packageRoot],
    { env: { npm_config_cache: npmCacheRoot } },
  );
  const output: unknown = JSON.parse(packed.stdout);
  const filename =
    Array.isArray(output) &&
    typeof output[0] === "object" &&
    output[0] !== null &&
    "filename" in output[0] &&
    typeof output[0].filename === "string"
      ? output[0].filename
      : undefined;
  if (filename === undefined) {
    throw new Error("npm pack did not report a fixture tarball filename");
  }
  return join(tarballsRoot, filename);
}

async function materializeInstallation(
  fixtureRoot: string,
  npmCacheRoot: string,
  packages: PackedFixturePackages,
  packageManager: PackageManager,
): Promise<PackageManagerInstallation> {
  const repositoryRoot = join(fixtureRoot, "repositories", packageManager.manager);
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(
    join(repositoryRoot, "package.json"),
    JSON.stringify({
      name: `fixture-${packageManager.manager}-repository`,
      private: true,
      dependencies: {
        "@typepeek-fixture/layout-subject": localPackageSpecifier(packages.subject),
        "@typepeek-fixture/nested": localPackageSpecifier(packages.nestedVersionTwo),
      },
    }),
  );

  const version = (await execa(packageManager.command, ["--version"])).stdout.trim();
  if (version !== packageManager.version) {
    throw new Error(
      `${packageManager.manager} ${packageManager.version} is required for the Supported Installation matrix; found ${version}.`,
    );
  }

  await installPackages(repositoryRoot, fixtureRoot, npmCacheRoot, packageManager);
  const subjectRoot = join(repositoryRoot, "node_modules", "@typepeek-fixture", "layout-subject");
  return {
    installSentinel: join(subjectRoot, "INSTALL_SCRIPT_EXECUTED"),
    manager: packageManager.manager,
    resolutionContext: repositoryRoot,
    subjectIsSymlink: (await lstat(subjectRoot)).isSymbolicLink(),
    subjectPhysicalPath: await realpath(subjectRoot),
    version,
  };
}

function localPackageSpecifier(packagePath: string): string {
  // Raw file specs preserve spaces; file URLs encode them incompatibly.
  return `file:${packagePath.split(sep).join("/")}`;
}

async function installPackages(
  repositoryRoot: string,
  fixtureRoot: string,
  npmCacheRoot: string,
  packageManager: PackageManager,
): Promise<void> {
  const commonOptions = { cwd: repositoryRoot };
  // Installers run only during fixture setup.
  switch (packageManager.manager) {
    case "npm":
      await execa(
        packageManager.command,
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
        ],
        { ...commonOptions, env: { npm_config_cache: npmCacheRoot } },
      );
      return;
    case "pnpm":
      await execa(
        packageManager.command,
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--lockfile=false",
          "--store-dir",
          join(fixtureRoot, "pnpm-store"),
        ],
        commonOptions,
      );
      return;
    case "bun":
      await execa(
        packageManager.command,
        ["install", "--offline", "--ignore-scripts", "--no-save"],
        {
          ...commonOptions,
          env: { BUN_INSTALL_CACHE_DIR: join(fixtureRoot, "bun-cache") },
        },
      );
  }
}
