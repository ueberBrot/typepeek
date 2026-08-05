import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PackageSource {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly declaration: string;
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
