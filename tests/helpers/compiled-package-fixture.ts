import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PackageSource {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly declaration: string;
  readonly additionalDeclarations?: Readonly<Record<string, string>>;
  readonly installedManifest?: string | Readonly<Record<string, unknown>>;
  readonly runtime: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: object;
}

const PACKAGE_SOURCES: readonly PackageSource[] = [
  {
    directory: "package",
    name: "@typepeek-fixture/compiled",
    version: "1.2.3",
    declaration: [
      "export interface WidgetOptions {",
      "  readonly size?: number;",
      "}",
      "export declare function createWidget(options?: WidgetOptions): string;",
      'export declare const VERSION: "1.2.3";',
      'export { dependencyExport } from "@typepeek-fixture/dependency";',
      "export default class Widget {}",
      "",
    ].join("\n"),
    runtime: [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("../RUNTIME_EXECUTED", import.meta.url), "executed");',
      'throw new Error("Typepeek executed the fixture runtime");',
      "",
    ].join("\n"),
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
  },
  {
    directory: "dependency-package",
    name: "@typepeek-fixture/dependency",
    version: "1.0.0",
    declaration: "export declare const dependencyExport: symbol;\n",
    runtime: 'throw new Error("Typepeek executed the dependency fixture runtime");\n',
  },
  {
    directory: "broad-package",
    name: "@typepeek-fixture/broad",
    version: "4.5.6",
    declaration: Array.from(
      { length: 201 },
      (_, index) => `export declare const item${index}: number;`,
    ).join("\n"),
    runtime: 'throw new Error("Typepeek executed the broad fixture runtime");\n',
  },
  {
    directory: "escaping-package",
    name: "@typepeek-fixture/escaping",
    version: "7.8.9",
    declaration: 'export * from "../../../../project-source.js";\n',
    runtime: 'throw new Error("Typepeek executed the escaping fixture runtime");\n',
  },
  {
    directory: "unresolved-package",
    name: "@typepeek-fixture/unresolved",
    version: "1.0.0",
    declaration: [
      'export * from "./missing.js";',
      "export declare const visibleExport: string;",
      "",
    ].join("\n"),
    runtime: 'throw new Error("Typepeek executed the unresolved fixture runtime");\n',
  },
  {
    directory: "conditional-package",
    name: "@typepeek-fixture/conditional",
    version: "1.0.0",
    declaration: "export declare const legacyExport: string;\n",
    additionalDeclarations: {
      "import.d.ts": "export declare const importExport: string;\n",
      "require.d.cts": "export declare const requireExport: string;\n",
    },
    runtime: 'throw new Error("Typepeek executed the conditional fixture runtime");\n',
    exports: {
      ".": {
        import: {
          types: "./dist/import.d.ts",
          default: "./dist/index.js",
        },
        require: {
          types: "./dist/require.d.cts",
          default: "./dist/index.js",
        },
      },
    },
  },
  {
    directory: "malformed-manifest-package",
    name: "@typepeek-fixture/malformed-manifest",
    version: "1.0.0",
    declaration: "export declare const manifestExport: string;\n",
    installedManifest: "{",
    runtime: 'throw new Error("Typepeek executed the malformed manifest fixture runtime");\n',
  },
  {
    directory: "invalid-version-package",
    name: "@typepeek-fixture/invalid-version",
    version: "1.0.0",
    declaration: "export declare const invalidVersionExport: string;\n",
    installedManifest: {
      name: "@typepeek-fixture/invalid-version",
      version: 42,
      type: "module",
      types: "./dist/index.d.ts",
    },
    runtime: 'throw new Error("Typepeek executed the invalid version fixture runtime");\n',
  },
];

const WORKSPACE_PACKAGE_SOURCES: readonly PackageSource[] = [
  {
    directory: "packages/workspace-main",
    name: "@typepeek-fixture/workspace-main",
    version: "1.0.0",
    declaration:
      'export { workspaceDependencyExport } from "@typepeek-fixture/workspace-dependency";\n',
    runtime: 'throw new Error("Typepeek executed the workspace fixture runtime");\n',
    dependencies: {
      "@typepeek-fixture/workspace-dependency": "1.0.0",
    },
  },
  {
    directory: "packages/workspace-dependency",
    name: "@typepeek-fixture/workspace-dependency",
    version: "1.0.0",
    declaration: "export declare const workspaceDependencyExport: symbol;\n",
    runtime: 'throw new Error("Typepeek executed the workspace dependency runtime");\n',
  },
];

export interface CompiledPackageFixture {
  readonly resolutionContext: string;
  readonly runtimeSentinel: string;
  readonly cleanup: () => Promise<void>;
}

export async function materializeCompiledPackageFixture(): Promise<CompiledPackageFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-compiled-package-"));
  const repositoryRoot = join(fixtureRoot, "repository");
  const tarballRoot = join(fixtureRoot, "tarballs");
  const npmCacheRoot = join(fixtureRoot, "npm-cache");

  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(repositoryRoot, "package.json"),
      JSON.stringify({
        name: "fixture-repository",
        private: true,
        workspaces: ["packages/*"],
      }),
    ),
    writeFile(
      join(repositoryRoot, "project-source.d.ts"),
      "export declare const leakedProjectExport: string;\n",
    ),
    ...PACKAGE_SOURCES.map((source) => writePackageSource(fixtureRoot, source)),
    ...WORKSPACE_PACKAGE_SOURCES.map((source) => writePackageSource(repositoryRoot, source)),
  ]);

  const tarballPaths = await Promise.all(
    PACKAGE_SOURCES.map((source) =>
      packPackage(join(fixtureRoot, source.directory), tarballRoot, npmCacheRoot),
    ),
  );
  await installPackages(repositoryRoot, npmCacheRoot, tarballPaths);
  await materializeInstalledEvidenceScenarios(repositoryRoot);

  return {
    resolutionContext: repositoryRoot,
    runtimeSentinel: join(
      repositoryRoot,
      "node_modules",
      "@typepeek-fixture",
      "compiled",
      "RUNTIME_EXECUTED",
    ),
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
}

async function materializeInstalledEvidenceScenarios(repositoryRoot: string): Promise<void> {
  await Promise.all(
    PACKAGE_SOURCES.flatMap((source) =>
      source.installedManifest === undefined
        ? []
        : [
            writeFile(
              join(repositoryRoot, "node_modules", ...source.name.split("/"), "package.json"),
              typeof source.installedManifest === "string"
                ? source.installedManifest
                : JSON.stringify(source.installedManifest),
            ),
          ],
    ),
  );
}

async function writePackageSource(fixtureRoot: string, source: PackageSource): Promise<void> {
  const packageRoot = join(fixtureRoot, source.directory);
  const packageDist = join(packageRoot, "dist");
  const manifest = {
    name: source.name,
    version: source.version,
    type: "module",
    types: "./dist/index.d.ts",
    files: ["dist"],
    ...(source.dependencies === undefined ? {} : { dependencies: source.dependencies }),
    ...(source.exports === undefined ? {} : { exports: source.exports }),
  };

  await mkdir(packageDist, { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest)),
    writeFile(join(packageDist, "index.d.ts"), source.declaration),
    writeFile(join(packageDist, "index.js"), source.runtime),
    ...Object.entries(source.additionalDeclarations ?? {}).map(([fileName, declaration]) =>
      writeFile(join(packageDist, fileName), declaration),
    ),
  ]);
}

async function packPackage(
  packageRoot: string,
  tarballRoot: string,
  npmCacheRoot: string,
): Promise<string> {
  const pack = await execa(
    "npm",
    ["pack", "--json", "--pack-destination", tarballRoot, packageRoot],
    { env: { npm_config_cache: npmCacheRoot } },
  );
  return join(tarballRoot, readPackedFilename(pack.stdout));
}

function readPackedFilename(output: string): string {
  const packOutput: unknown = JSON.parse(output);
  const firstResult = Array.isArray(packOutput) ? packOutput[0] : undefined;

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

async function installPackages(
  repositoryRoot: string,
  npmCacheRoot: string,
  tarballPaths: readonly string[],
): Promise<void> {
  await execa(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...tarballPaths,
    ],
    {
      cwd: repositoryRoot,
      env: { npm_config_cache: npmCacheRoot },
    },
  );
}
