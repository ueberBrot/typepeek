import { mkdir } from "node:fs/promises";
import nodePath from "node:path";

import { runCommand } from "#typepeek/platform/process-command";
import { unreachableCase } from "#typepeek/shared/unreachable-case";

const IGNORE_SCRIPTS = "--ignore-scripts";
const NO_AUDIT = "--no-audit";

export const PACKAGE_MANAGER_PINS = [
  { command: "npm", manager: "npm", version: "11.19.1" },
  { command: "pnpm", manager: "pnpm", version: "12.16.1" },
  { command: "bun", manager: "bun", version: "1.4.4" },
] as const;

export type PackageManagerPin = (typeof PACKAGE_MANAGER_PINS)[number];

export const localPackageSpecifier = function localPackageSpecifier(
  packagePath: string
): string {
  // Raw file specs preserve spaces; file URLs encode them incompatibly.
  return `file:${packagePath.split(nodePath.sep).join("/")}`;
};

const runToolchainCommand = async function runToolchainCommand(options: {
  readonly cliArguments: readonly string[];
  readonly command: string;
  readonly diagnosticContext: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<{
  readonly stdout: string;
}> {
  try {
    const result =
      options.env === undefined
        ? await runCommand(options.command, options.cliArguments, {
            cwd: options.cwd,
          })
        : await runCommand(options.command, options.cliArguments, {
            cwd: options.cwd,
            env: options.env,
          });

    return { stdout: result.stdout };
  } catch (error) {
    throw new Error(
      `${options.diagnosticContext}; command ${JSON.stringify([options.command, ...options.cliArguments])} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

export const packPackage = async function packPackage(options: {
  readonly diagnosticContext: string;
  readonly packageRoot: string;
  readonly tarballsRoot: string;
}): Promise<string> {
  await mkdir(options.tarballsRoot, { recursive: true });

  const packed = await runToolchainCommand({
    cliArguments: [
      "pm",
      "pack",
      "--quiet",
      IGNORE_SCRIPTS,
      "--destination",
      options.tarballsRoot,
    ],
    command: "bun",
    cwd: options.packageRoot,
    diagnosticContext: options.diagnosticContext,
  });

  return nodePath.resolve(options.tarballsRoot, packed.stdout.trim());
};

const verifyPackageManager = async function verifyPackageManager(
  packageManager: PackageManagerPin,
  resolutionContext: string
): Promise<string> {
  const runToolchainCommandResult = await runToolchainCommand({
    cliArguments: ["--version"],
    command: packageManager.command,
    cwd: resolutionContext,
    diagnosticContext: `${packageManager.manager} Resolution Context ${resolutionContext} version check`,
  });

  const version = runToolchainCommandResult.stdout.trim();

  if (version !== packageManager.version) {
    throw new Error(
      `${packageManager.manager} Resolution Context ${resolutionContext} requires ${packageManager.version}; found ${version}.`
    );
  }

  return version;
};

export const installDeclaredPackages =
  async function installDeclaredPackages(options: {
    readonly cacheRoot: string;
    readonly diagnosticContext: string;
    readonly offline: boolean;
    readonly packageManager: PackageManagerPin;
    readonly resolutionContext: string;
  }): Promise<string> {
    const version = await verifyPackageManager(
      options.packageManager,
      options.resolutionContext
    );

    const offlineArguments = options.offline ? ["--offline"] : [];

    switch (options.packageManager.manager) {
      case "npm": {
        await runToolchainCommand({
          cliArguments: [
            "install",
            ...offlineArguments,
            IGNORE_SCRIPTS,
            NO_AUDIT,
            "--no-fund",
            "--package-lock=false",
          ],
          command: options.packageManager.command,
          cwd: options.resolutionContext,
          diagnosticContext: options.diagnosticContext,
          env: {
            npm_config_cache: nodePath.join(options.cacheRoot, "npm-cache"),
          },
        });

        return version;
      }

      case "pnpm": {
        await runToolchainCommand({
          cliArguments: [
            "install",
            ...offlineArguments,
            IGNORE_SCRIPTS,
            "--lockfile=false",
            "--store-dir",
            nodePath.join(options.cacheRoot, "pnpm-store"),
          ],
          command: options.packageManager.command,
          cwd: options.resolutionContext,
          diagnosticContext: options.diagnosticContext,
        });

        return version;
      }

      case "bun": {
        await runToolchainCommand({
          cliArguments: [
            "install",
            ...offlineArguments,
            IGNORE_SCRIPTS,
            "--no-save",
          ],
          command: options.packageManager.command,
          cwd: options.resolutionContext,
          diagnosticContext: options.diagnosticContext,
          env: {
            BUN_INSTALL_CACHE_DIR: nodePath.join(
              options.cacheRoot,
              "bun-cache"
            ),
          },
        });

        return version;
      }

      default: {
        return unreachableCase(options.packageManager);
      }
    }
  };

export const installPackedPackagesWithNpm =
  async function installPackedPackagesWithNpm(options: {
    readonly diagnosticContext: string;
    readonly npmCacheRoot: string;
    readonly packagePaths: readonly string[];
    readonly resolutionContext: string;
  }): Promise<void> {
    const [npm] = PACKAGE_MANAGER_PINS;
    await verifyPackageManager(npm, options.resolutionContext);
    await runToolchainCommand({
      cliArguments: [
        "install",
        "--offline",
        IGNORE_SCRIPTS,
        NO_AUDIT,
        "--no-fund",
        "--package-lock=false",
        ...options.packagePaths,
      ],
      command: npm.command,
      cwd: options.resolutionContext,
      diagnosticContext: options.diagnosticContext,
      env: { npm_config_cache: options.npmCacheRoot },
    });
  };

export const installLockedPackagesWithNpm =
  async function installLockedPackagesWithNpm(options: {
    readonly cacheRoot: string;
    readonly diagnosticContext: string;
    readonly resolutionContext: string;
  }): Promise<void> {
    const [npm] = PACKAGE_MANAGER_PINS;
    await verifyPackageManager(npm, options.resolutionContext);
    await runToolchainCommand({
      cliArguments: ["ci", IGNORE_SCRIPTS, NO_AUDIT, "--no-fund"],
      command: npm.command,
      cwd: options.resolutionContext,
      diagnosticContext: options.diagnosticContext,
      env: { npm_config_cache: nodePath.join(options.cacheRoot, "npm-cache") },
    });
  };
