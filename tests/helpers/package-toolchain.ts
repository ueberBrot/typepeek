import { execa } from "execa";
import { mkdir } from "node:fs/promises";
import { join, sep } from "node:path";

export const PACKAGE_MANAGER_PINS = [
  { command: "npm", manager: "npm", version: "11.16.0" },
  { command: "pnpm", manager: "pnpm", version: "11.20.0" },
  { command: "bun", manager: "bun", version: "1.4.0" },
] as const;

export type PackageManagerPin = (typeof PACKAGE_MANAGER_PINS)[number];

export function localPackageSpecifier(packagePath: string): string {
  // Raw file specs preserve spaces; file URLs encode them incompatibly.
  return `file:${packagePath.split(sep).join("/")}`;
}

export async function packPackage(options: {
  readonly diagnosticContext: string;
  readonly npmCacheRoot: string;
  readonly packageRoot: string;
  readonly tarballsRoot: string;
}): Promise<string> {
  await mkdir(options.tarballsRoot, { recursive: true });
  const packed = await runToolchainCommand({
    command: "npm",
    arguments_: [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      options.tarballsRoot,
      options.packageRoot,
    ],
    cwd: options.packageRoot,
    env: { npm_config_cache: options.npmCacheRoot },
    diagnosticContext: options.diagnosticContext,
  });
  return join(options.tarballsRoot, readPackedFilename(packed.stdout));
}

export async function installDeclaredPackages(options: {
  readonly cacheRoot: string;
  readonly diagnosticContext: string;
  readonly offline: boolean;
  readonly packageManager: PackageManagerPin;
  readonly resolutionContext: string;
}): Promise<string> {
  const version = await verifyPackageManager(options.packageManager, options.resolutionContext);
  const offlineArguments = options.offline ? ["--offline"] : [];

  switch (options.packageManager.manager) {
    case "npm":
      await runToolchainCommand({
        command: options.packageManager.command,
        arguments_: [
          "install",
          ...offlineArguments,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
        ],
        cwd: options.resolutionContext,
        env: { npm_config_cache: join(options.cacheRoot, "npm-cache") },
        diagnosticContext: options.diagnosticContext,
      });
      return version;
    case "pnpm":
      await runToolchainCommand({
        command: options.packageManager.command,
        arguments_: [
          "install",
          ...offlineArguments,
          "--ignore-scripts",
          "--lockfile=false",
          "--store-dir",
          join(options.cacheRoot, "pnpm-store"),
        ],
        cwd: options.resolutionContext,
        diagnosticContext: options.diagnosticContext,
      });
      return version;
    case "bun":
      await runToolchainCommand({
        command: options.packageManager.command,
        arguments_: ["install", ...offlineArguments, "--ignore-scripts", "--no-save"],
        cwd: options.resolutionContext,
        env: { BUN_INSTALL_CACHE_DIR: join(options.cacheRoot, "bun-cache") },
        diagnosticContext: options.diagnosticContext,
      });
      return version;
  }
}

export async function installPackedPackagesWithNpm(options: {
  readonly diagnosticContext: string;
  readonly npmCacheRoot: string;
  readonly packagePaths: readonly string[];
  readonly resolutionContext: string;
}): Promise<void> {
  const npm = PACKAGE_MANAGER_PINS[0];
  await verifyPackageManager(npm, options.resolutionContext);
  await runToolchainCommand({
    command: npm.command,
    arguments_: [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...options.packagePaths,
    ],
    cwd: options.resolutionContext,
    env: { npm_config_cache: options.npmCacheRoot },
    diagnosticContext: options.diagnosticContext,
  });
}

export async function installLockedPackagesWithNpm(options: {
  readonly cacheRoot: string;
  readonly diagnosticContext: string;
  readonly resolutionContext: string;
}): Promise<void> {
  const npm = PACKAGE_MANAGER_PINS[0];
  await verifyPackageManager(npm, options.resolutionContext);
  await runToolchainCommand({
    command: npm.command,
    arguments_: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: options.resolutionContext,
    env: { npm_config_cache: join(options.cacheRoot, "npm-cache") },
    diagnosticContext: options.diagnosticContext,
  });
}

async function verifyPackageManager(
  packageManager: PackageManagerPin,
  resolutionContext: string,
): Promise<string> {
  const version = (
    await runToolchainCommand({
      command: packageManager.command,
      arguments_: ["--version"],
      cwd: resolutionContext,
      diagnosticContext: `${packageManager.manager} Resolution Context ${resolutionContext} version check`,
    })
  ).stdout.trim();
  if (version !== packageManager.version) {
    throw new Error(
      `${packageManager.manager} Resolution Context ${resolutionContext} requires ${packageManager.version}; found ${version}.`,
    );
  }
  return version;
}

function readPackedFilename(stdout: string): string {
  const output: unknown = JSON.parse(stdout);
  const firstResult = Array.isArray(output) ? output[0] : undefined;
  if (
    typeof firstResult !== "object" ||
    firstResult === null ||
    !("filename" in firstResult) ||
    typeof firstResult.filename !== "string"
  ) {
    throw new Error("npm pack did not report a tarball filename");
  }
  return firstResult.filename;
}

async function runToolchainCommand(options: {
  readonly arguments_: readonly string[];
  readonly command: string;
  readonly diagnosticContext: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<{ readonly stdout: string }> {
  try {
    const result =
      options.env === undefined
        ? await execa(options.command, options.arguments_, { cwd: options.cwd })
        : await execa(options.command, options.arguments_, {
            cwd: options.cwd,
            env: options.env,
          });
    return { stdout: result.stdout };
  } catch (error) {
    throw new Error(
      `${options.diagnosticContext}; command ${JSON.stringify([options.command, ...options.arguments_])} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
