import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Predicate, Schema } from "effect";

import { runCommand } from "#typepeek/platform/process-command";
import { bitwiseAnd, unsignedRightShift } from "#typepeek/shared/integer-bits";
import { decodeJson } from "#typepeek/shared/json-data";

import type { PackageManagerPin } from "./package-toolchain.ts";
import {
  installDeclaredPackages,
  localPackageSpecifier,
  PACKAGE_MANAGER_PINS,
  packPackage,
} from "./package-toolchain.ts";
import { materializeStaticInspection } from "./static-inspection.ts";

const INSPECTION_TARGET_PINS = {
  publint: "0.3.22",
  zod: "4.4.3",
} as const;

const BUN_WINDOWS_SHIM_VERSION = 5478;

export interface PackagedCliConsumer {
  readonly analysisProcessEntryPath: string;
  readonly executableKind: "link" | "shim";
  readonly executablePath: string;
  readonly manager: PackageManagerPin["manager"];
  readonly packageScriptSentinel: string;
  readonly productionDependencyPaths: readonly string[];
  readonly resolutionContext: string;
  readonly run: (cliArguments: readonly string[]) => Promise<{
    readonly stdout: string;
  }>;
  readonly typepeekTarballPath: string;
  readonly version: string;
  readonly verifyNoLibraryImports: () => Promise<void>;
  readonly verifyNoInspectionIo: () => Promise<void>;
}

export interface PackagedCliMatrix {
  readonly cleanup: () => Promise<void>;
  readonly consumers: readonly PackagedCliConsumer[];
  readonly typepeekTarballPath: string;
}

const buildAndPackTypepeek = async function buildAndPackTypepeek(
  sourceCheckout: string,
  fixtureRoot: string
): Promise<string> {
  const tarballsRoot = nodePath.join(fixtureRoot, "tarballs");
  const npmCacheRoot = nodePath.join(fixtureRoot, "pack-cache");
  await mkdir(tarballsRoot, { recursive: true });

  try {
    await runCommand("vp", ["pack"], { cwd: sourceCheckout });
  } catch (error) {
    throw new Error(`Production build in ${sourceCheckout} failed.`, {
      cause: error,
    });
  }

  return await packPackage({
    diagnosticContext: `production tarball from ${sourceCheckout}`,
    npmCacheRoot,
    packageRoot: sourceCheckout,
    tarballsRoot,
  });
};

const executableFilename = function executableFilename(
  packageManager: PackageManagerPin
): string {
  if (process.platform !== "win32") {
    return "typepeek";
  }

  return packageManager.manager === "bun" ? "typepeek.exe" : "typepeek.cmd";
};

const pathIsInside = function pathIsInside(
  parentPath: string,
  childPath: string
): boolean {
  const relativePath = nodePath.relative(parentPath, childPath);

  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relativePath))
  );
};

const resolveProductionDependencyPaths =
  async function resolveProductionDependencyPaths(
    typepeekPackageRoot: string
  ): Promise<readonly string[]> {
    const manifestPath = nodePath.join(typepeekPackageRoot, "package.json");

    const manifest = decodeJson(
      Schema.MutableJson,
      await readFile(manifestPath, "utf-8")
    );

    if (
      !Predicate.isObjectOrArray(manifest) ||
      !("dependencies" in manifest) ||
      !Predicate.isReadonlyObject(manifest.dependencies) ||
      manifest.dependencies === null
    ) {
      throw new Error(
        `Packed Typepeek manifest ${manifestPath} has no production dependencies.`
      );
    }

    const requireFromTypepeek = createRequire(manifestPath);

    return Object.keys(manifest.dependencies).map((packageName) =>
      requireFromTypepeek.resolve(packageName)
    );
  };

const invalidBunShimError = function invalidBunShimError(
  metadataPath: string,
  expectedCliEntry: string,
  packageManager: PackageManagerPin,
  resolutionContext: string
): Error {
  return new Error(
    `${packageManager.manager} consumer Resolution Context ${resolutionContext} executable metadata ${metadataPath} does not target ${expectedCliEntry}.`
  );
};

const verifyBunWindowsExecutable = async function verifyBunWindowsExecutable(
  executablePath: string,
  expectedCliEntry: string,
  packageManager: PackageManagerPin,
  resolutionContext: string
): Promise<void> {
  await lstat(executablePath);
  // Bun stores its UTF-16LE target and format version in paired metadata.
  const metadataPath = executablePath.replace(/\.exe$/u, ".bunx");
  const metadata = await readFile(metadataPath);

  if (metadata.length < 10) {
    throw invalidBunShimError(
      metadataPath,
      expectedCliEntry,
      packageManager,
      resolutionContext
    );
  }

  const flags = metadata.readUInt16LE(metadata.length - 2);
  const binPathByteLength = metadata.readUInt32LE(metadata.length - 10);

  const quoteAndTerminator = metadata.subarray(
    binPathByteLength,
    binPathByteLength + 4
  );

  const hasNodeShebang = bitwiseAnd(flags, 0b111) === 0b111;

  const hasSupportedVersion =
    unsignedRightShift(flags, 3) === BUN_WINDOWS_SHIM_VERSION;

  const hasValidBinPath =
    binPathByteLength > 0 &&
    binPathByteLength % 2 === 0 &&
    binPathByteLength + 4 <= metadata.length - 10;

  if (
    !hasNodeShebang ||
    !hasSupportedVersion ||
    !hasValidBinPath ||
    !quoteAndTerminator.equals(Buffer.from([0x22, 0x00, 0x00, 0x00]))
  ) {
    throw invalidBunShimError(
      metadataPath,
      expectedCliEntry,
      packageManager,
      resolutionContext
    );
  }

  const encodedTarget = metadata
    .subarray(0, binPathByteLength)
    .toString("utf16le");

  const executableTarget = await realpath(
    nodePath.join(
      nodePath.dirname(nodePath.dirname(executablePath)),
      encodedTarget
    )
  );

  if (executableTarget !== expectedCliEntry) {
    throw invalidBunShimError(
      metadataPath,
      expectedCliEntry,
      packageManager,
      resolutionContext
    );
  }
};

const verifyExecutableTarget = async function verifyExecutableTarget(
  executablePath: string,
  typepeekPhysicalPath: string,
  packageManager: PackageManagerPin,
  resolutionContext: string
): Promise<"link" | "shim"> {
  const expectedCliEntry = nodePath.join(
    typepeekPhysicalPath,
    "dist",
    "cli.js"
  );

  if (process.platform === "win32" && packageManager.manager === "bun") {
    await verifyBunWindowsExecutable(
      executablePath,
      expectedCliEntry,
      packageManager,
      resolutionContext
    );

    return "shim";
  }

  const lstatResult = await lstat(executablePath);

  if (lstatResult.isSymbolicLink()) {
    const executableTarget = await realpath(executablePath);

    if (executableTarget !== expectedCliEntry) {
      throw new Error(
        `${packageManager.manager} consumer Resolution Context ${resolutionContext} executable link targets ${executableTarget} instead of ${expectedCliEntry}.`
      );
    }

    return "link";
  }

  const readFileResult = await readFile(executablePath, "utf-8");

  const normalizedShim = readFileResult.replaceAll("\\", "/");

  const executablePhysicalDirectory = await realpath(
    nodePath.dirname(executablePath)
  );

  const normalizedRelativeTarget = nodePath
    .relative(executablePhysicalDirectory, expectedCliEntry)
    .replaceAll("\\", "/");

  if (!normalizedShim.includes(normalizedRelativeTarget)) {
    // Installers may target the installed package link instead of its physical store path.
    const installedModulesDirectory = await realpath(
      nodePath.join(resolutionContext, "node_modules")
    );

    const linkedCliEntry = nodePath.join(
      installedModulesDirectory,
      "typepeek",
      "dist",
      "cli.js"
    );

    const normalizedLinkedTarget = nodePath
      .relative(executablePhysicalDirectory, linkedCliEntry)
      .replaceAll("\\", "/");

    if (
      (await realpath(linkedCliEntry)) !== expectedCliEntry ||
      !normalizedShim.includes(normalizedLinkedTarget)
    ) {
      throw new Error(
        `${packageManager.manager} consumer Resolution Context ${resolutionContext} executable shim does not target ${expectedCliEntry}.`
      );
    }
  }

  return "shim";
};

const materializeConsumer = async function materializeConsumer(
  sourceCheckout: string,
  fixtureRoot: string,
  typepeekTarballPath: string,
  packageManager: PackageManagerPin
): Promise<PackagedCliConsumer> {
  const resolutionContext = nodePath.join(
    fixtureRoot,
    "consumers",
    packageManager.manager
  );

  const packageScriptSentinel = nodePath.join(
    resolutionContext,
    "PACKAGE_SCRIPT_EXECUTED"
  );

  await mkdir(resolutionContext, { recursive: true });
  await writeFile(
    nodePath.join(resolutionContext, "package.json"),
    JSON.stringify({
      dependencies: {
        ...INSPECTION_TARGET_PINS,
        typepeek: localPackageSpecifier(typepeekTarballPath),
      },
      name: `typepeek-${packageManager.manager}-consumer`,
      private: true,
      scripts: {
        preinstall:
          "node -e \"require('node:fs').writeFileSync('PACKAGE_SCRIPT_EXECUTED', 'executed')\"",
      },
    })
  );

  const version = await installDeclaredPackages({
    cacheRoot: fixtureRoot,
    diagnosticContext: `${packageManager.manager} consumer Resolution Context ${resolutionContext}, installed packages ${["typepeek", ...Object.keys(INSPECTION_TARGET_PINS)].join(", ")}`,
    offline: false,
    packageManager,
    resolutionContext,
  });

  const staticInspection = await materializeStaticInspection(resolutionContext);

  const executablePath = nodePath.join(
    resolutionContext,
    "node_modules",
    ".bin",
    executableFilename(packageManager)
  );

  const typepeekPackageRoot = nodePath.join(
    resolutionContext,
    "node_modules",
    "typepeek"
  );

  const typepeekPhysicalPath = await realpath(typepeekPackageRoot);

  if (pathIsInside(sourceCheckout, typepeekPhysicalPath)) {
    throw new Error(
      `${packageManager.manager} consumer Resolution Context ${resolutionContext} installed typepeek from the source checkout instead of ${typepeekTarballPath}.`
    );
  }

  const productionDependencyPaths =
    await resolveProductionDependencyPaths(typepeekPhysicalPath);

  const executableKind = await verifyExecutableTarget(
    executablePath,
    typepeekPhysicalPath,
    packageManager,
    resolutionContext
  );

  const analysisProcessEntryPath = nodePath.join(
    typepeekPackageRoot,
    "dist",
    "inspection",
    "analysis-process-entry.js"
  );

  return {
    analysisProcessEntryPath,
    executableKind,
    executablePath,
    manager: packageManager.manager,
    packageScriptSentinel,
    productionDependencyPaths,
    resolutionContext,
    run: async (cliArguments) =>
      await staticInspection.run({
        adapter: {
          analysisProcessEntryPath,
          executablePath,
          kind: "installed",
        },
        cliArguments,
        diagnosticContext: `${packageManager.manager} consumer Resolution Context ${resolutionContext}, installed package ${cliArguments[0] ?? "unknown"}`,
        resolutionContext,
      }),
    typepeekTarballPath,
    verifyNoInspectionIo: staticInspection.verifyNoIo,
    verifyNoLibraryImports: async () => {
      const script = [
        'for (const specifier of ["typepeek", "typepeek/inspection"]) {',
        "  try {",
        "    await import(specifier);",
        `    throw new Error(\`\${specifier} unexpectedly exposed a JavaScript module\`);`,
        "  } catch (error) {",
        '    if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;',
        "  }",
        "}",
      ].join("\n");

      await runCommand(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          cwd: resolutionContext,
        }
      );
    },
    version,
  };
};

export const materializePackagedCliMatrix =
  async function materializePackagedCliMatrix(): Promise<PackagedCliMatrix> {
    const sourceCheckout = await realpath(process.cwd());

    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek packaged cli-")
    );

    try {
      const typepeekTarballPath = await buildAndPackTypepeek(
        sourceCheckout,
        fixtureRoot
      );

      const consumers: PackagedCliConsumer[] = [];

      await Array.fromAsync(PACKAGE_MANAGER_PINS, async (packageManager) => {
        consumers.push(
          await materializeConsumer(
            sourceCheckout,
            fixtureRoot,
            typepeekTarballPath,
            packageManager
          )
        );
      });

      return {
        cleanup: async () => {
          await rm(fixtureRoot, { force: true, recursive: true });
        },
        consumers,
        typepeekTarballPath,
      };
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
  };
