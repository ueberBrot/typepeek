import { execa } from "execa";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  installDeclaredPackages,
  localPackageSpecifier,
  type PackageManagerPin,
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
  readonly run: (arguments_: readonly string[]) => Promise<{ readonly stdout: string }>;
  readonly runInspectionApi: () => Promise<unknown>;
  readonly typecheckInspectionApi: () => Promise<void>;
  readonly typepeekTarballPath: string;
  readonly version: string;
  readonly verifyNoInspectionIo: () => Promise<void>;
}

export interface PackagedCliMatrix {
  readonly cleanup: () => Promise<void>;
  readonly consumers: readonly PackagedCliConsumer[];
  readonly typepeekTarballPath: string;
}

export async function materializePackagedCliMatrix(): Promise<PackagedCliMatrix> {
  const sourceCheckout = await realpath(process.cwd());
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-packaged-cli-"));

  try {
    const typepeekTarballPath = await buildAndPackTypepeek(sourceCheckout, fixtureRoot);
    const consumers = [];

    for (const packageManager of PACKAGE_MANAGER_PINS) {
      consumers.push(
        await materializeConsumer(sourceCheckout, fixtureRoot, typepeekTarballPath, packageManager),
      );
    }

    return {
      cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
      consumers,
      typepeekTarballPath,
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function buildAndPackTypepeek(sourceCheckout: string, fixtureRoot: string): Promise<string> {
  const tarballsRoot = join(fixtureRoot, "tarballs");
  const npmCacheRoot = join(fixtureRoot, "pack-cache");
  await mkdir(tarballsRoot, { recursive: true });

  try {
    await execa("vp", ["pack"], { cwd: sourceCheckout });
  } catch (error) {
    throw new Error(`Production build in ${sourceCheckout} failed.`, { cause: error });
  }
  return packPackage({
    diagnosticContext: `production tarball from ${sourceCheckout}`,
    npmCacheRoot,
    packageRoot: sourceCheckout,
    tarballsRoot,
  });
}

async function materializeConsumer(
  sourceCheckout: string,
  fixtureRoot: string,
  typepeekTarballPath: string,
  packageManager: PackageManagerPin,
): Promise<PackagedCliConsumer> {
  const resolutionContext = join(fixtureRoot, "consumers", packageManager.manager);
  const packageScriptSentinel = join(resolutionContext, "PACKAGE_SCRIPT_EXECUTED");
  await mkdir(resolutionContext, { recursive: true });
  await writeFile(
    join(resolutionContext, "package.json"),
    JSON.stringify({
      name: `typepeek-${packageManager.manager}-consumer`,
      private: true,
      scripts: {
        preinstall:
          "node -e \"require('node:fs').writeFileSync('PACKAGE_SCRIPT_EXECUTED', 'executed')\"",
      },
      dependencies: {
        ...INSPECTION_TARGET_PINS,
        typepeek: localPackageSpecifier(typepeekTarballPath),
      },
    }),
  );

  const version = await installDeclaredPackages({
    cacheRoot: fixtureRoot,
    diagnosticContext: `${packageManager.manager} consumer Resolution Context ${resolutionContext}, installed packages ${["typepeek", ...Object.keys(INSPECTION_TARGET_PINS)].join(", ")}`,
    offline: false,
    packageManager,
    resolutionContext,
  });
  const staticInspection = await materializeStaticInspection(resolutionContext);

  const executablePath = join(
    resolutionContext,
    "node_modules",
    ".bin",
    executableFilename(packageManager),
  );
  const typepeekPackageRoot = join(resolutionContext, "node_modules", "typepeek");
  const typepeekPhysicalPath = await realpath(typepeekPackageRoot);
  if (pathIsInside(sourceCheckout, typepeekPhysicalPath)) {
    throw new Error(
      `${packageManager.manager} consumer Resolution Context ${resolutionContext} installed typepeek from the source checkout instead of ${typepeekTarballPath}.`,
    );
  }
  const productionDependencyPaths = await resolveProductionDependencyPaths(typepeekPhysicalPath);
  const executableKind = await verifyExecutableTarget(
    executablePath,
    typepeekPhysicalPath,
    packageManager,
    resolutionContext,
  );
  const analysisProcessEntryPath = join(
    typepeekPackageRoot,
    "dist",
    "inspection",
    "analysis-process-entry.js",
  );

  return {
    analysisProcessEntryPath,
    executableKind,
    executablePath,
    manager: packageManager.manager,
    packageScriptSentinel,
    productionDependencyPaths,
    resolutionContext,
    run: async (arguments_) => {
      return staticInspection.run({
        adapter: { analysisProcessEntryPath, executablePath, kind: "installed" },
        arguments_,
        diagnosticContext: `${packageManager.manager} consumer Resolution Context ${resolutionContext}, installed package ${arguments_[0] ?? "unknown"}`,
        resolutionContext,
      });
    },
    runInspectionApi: async () => {
      const script = [
        'import { inspectExport, inspectExportSignatures, inspectInterfaceOverview } from "typepeek/inspection";',
        `const resolutionContext = ${JSON.stringify(resolutionContext)};`,
        'const overview = await inspectInterfaceOverview({ resolutionContext, specifier: "publint" });',
        'const focused = await inspectExport({ resolutionContext, specifier: "publint/utils", exportName: "formatMessage" });',
        'const signatures = await inspectExportSignatures({ resolutionContext, specifier: "zod", exportName: "ZodError" });',
        "process.stdout.write(JSON.stringify({ overview, focused, signatures }));",
      ].join("\n");
      const result = await execa(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: resolutionContext,
      });
      return JSON.parse(result.stdout) as unknown;
    },
    typecheckInspectionApi: async () => {
      const sourcePath = join(resolutionContext, "inspection-api-consumer.mts");
      await writeFile(
        sourcePath,
        [
          'import type { InspectedSignature, ResolutionVariant, SignatureBinding, SignatureParameter, SignatureReturn, SignatureThisParameter, SignatureTypeParameter, SignatureTypeParameterModifier } from "typepeek/inspection";',
          "declare const signature: InspectedSignature;",
          "declare const binding: SignatureBinding;",
          "declare const parameter: SignatureParameter;",
          "declare const returned: SignatureReturn;",
          "declare const thisParameter: SignatureThisParameter;",
          "declare const typeParameter: SignatureTypeParameter;",
          "declare const modifier: SignatureTypeParameterModifier;",
          "declare const resolutionVariant: ResolutionVariant;",
          "void [signature, binding, parameter, returned, thisParameter, typeParameter, modifier, resolutionVariant];",
        ].join("\n"),
      );
      await execa(join(sourceCheckout, "node_modules", ".bin", "tsc6"), [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2024",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        sourcePath,
      ]);
    },
    typepeekTarballPath,
    version,
    verifyNoInspectionIo: staticInspection.verifyNoIo,
  };
}

async function verifyExecutableTarget(
  executablePath: string,
  typepeekPhysicalPath: string,
  packageManager: PackageManagerPin,
  resolutionContext: string,
): Promise<"link" | "shim"> {
  const expectedCliEntry = join(typepeekPhysicalPath, "dist", "cli.js");
  if (process.platform === "win32" && packageManager.manager === "bun") {
    await verifyBunWindowsExecutable(
      executablePath,
      expectedCliEntry,
      packageManager,
      resolutionContext,
    );
    return "shim";
  }

  if ((await lstat(executablePath)).isSymbolicLink()) {
    const executableTarget = await realpath(executablePath);
    if (executableTarget !== expectedCliEntry) {
      throw new Error(
        `${packageManager.manager} consumer Resolution Context ${resolutionContext} executable link targets ${executableTarget} instead of ${expectedCliEntry}.`,
      );
    }
    return "link";
  }

  const normalizedShim = (await readFile(executablePath, "utf8")).replaceAll("\\", "/");
  const executablePhysicalDirectory = await realpath(dirname(executablePath));
  const normalizedRelativeTarget = relative(
    executablePhysicalDirectory,
    expectedCliEntry,
  ).replaceAll("\\", "/");
  if (!normalizedShim.includes(normalizedRelativeTarget)) {
    throw new Error(
      `${packageManager.manager} consumer Resolution Context ${resolutionContext} executable shim does not target ${expectedCliEntry}.`,
    );
  }
  return "shim";
}

function executableFilename(packageManager: PackageManagerPin): string {
  if (process.platform !== "win32") {
    return "typepeek";
  }
  return packageManager.manager === "bun" ? "typepeek.exe" : "typepeek.cmd";
}

async function verifyBunWindowsExecutable(
  executablePath: string,
  expectedCliEntry: string,
  packageManager: PackageManagerPin,
  resolutionContext: string,
): Promise<void> {
  await lstat(executablePath);
  // Bun 1.3.14 stores its UTF-16LE target and format version in paired metadata.
  const metadataPath = executablePath.replace(/\.exe$/u, ".bunx");
  const metadata = await readFile(metadataPath);
  if (metadata.length < 10) {
    throw invalidBunShimError(metadataPath, expectedCliEntry, packageManager, resolutionContext);
  }

  const flags = metadata.readUInt16LE(metadata.length - 2);
  const binPathByteLength = metadata.readUInt32LE(metadata.length - 10);
  const quoteAndTerminator = metadata.subarray(binPathByteLength, binPathByteLength + 4);
  const hasNodeShebang = (flags & 0b111) === 0b111;
  const hasSupportedVersion = flags >>> 3 === BUN_WINDOWS_SHIM_VERSION;
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
    throw invalidBunShimError(metadataPath, expectedCliEntry, packageManager, resolutionContext);
  }

  const encodedTarget = metadata.subarray(0, binPathByteLength).toString("utf16le");
  const executableTarget = await realpath(join(dirname(dirname(executablePath)), encodedTarget));
  if (executableTarget !== expectedCliEntry) {
    throw invalidBunShimError(metadataPath, expectedCliEntry, packageManager, resolutionContext);
  }
}

function invalidBunShimError(
  metadataPath: string,
  expectedCliEntry: string,
  packageManager: PackageManagerPin,
  resolutionContext: string,
): Error {
  return new Error(
    `${packageManager.manager} consumer Resolution Context ${resolutionContext} executable metadata ${metadataPath} does not target ${expectedCliEntry}.`,
  );
}

async function resolveProductionDependencyPaths(
  typepeekPackageRoot: string,
): Promise<readonly string[]> {
  const manifestPath = join(typepeekPackageRoot, "package.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("dependencies" in manifest) ||
    typeof manifest.dependencies !== "object" ||
    manifest.dependencies === null
  ) {
    throw new Error(`Packed Typepeek manifest ${manifestPath} has no production dependencies.`);
  }

  const requireFromTypepeek = createRequire(manifestPath);
  return Object.keys(manifest.dependencies).map((packageName) =>
    requireFromTypepeek.resolve(packageName),
  );
}

function pathIsInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
