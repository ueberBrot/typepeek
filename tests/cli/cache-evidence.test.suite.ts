import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import {
  decodeJson,
  mutableJsonObjectSchema,
} from "#typepeek/shared/json-data";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { profilePhaseNames } from "../helpers/inspection-profile.ts";

export const registerCacheEvidenceTests = function registerCacheEvidenceTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("reuses complete outcomes backed by transitive installed declarations", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-transitive-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/compiled",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-hit"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, false]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("reuses outcomes resolved through a workspace-linked package", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-workspace-link-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/workspace-main",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-hit"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, false]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("invalidates when transitive declaration resolution selects a nearer package", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-resolution-test-")
    );

    const compiledRoot = nodePath.join(
      getFixture().resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "compiled"
    );

    const rootDependency = nodePath.join(
      getFixture().resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "dependency"
    );

    const nestedNodeModules = nodePath.join(compiledRoot, "node_modules");

    const nestedDependency = nodePath.join(
      nestedNodeModules,
      "@typepeek-fixture",
      "dependency"
    );

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/compiled",
      "dependencyExport",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await cp(rootDependency, nestedDependency, { recursive: true });

      const nestedDeclarationPath = nodePath.join(
        nestedDependency,
        "dist",
        "index.d.ts"
      );

      const readFileResult = await readFile(nestedDeclarationPath, "utf-8");
      await writeFile(
        nestedDeclarationPath,
        readFileResult.replace(
          "dependencyExport: symbol",
          "dependencyExport: string"
        )
      );

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        Object.is(repeated.stdout, first.stdout),
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([false, true, true]);
    } finally {
      await Promise.all([
        rm(cacheDirectory, { force: true, recursive: true }),
        rm(nestedNodeModules, { force: true, recursive: true }),
      ]);
    }
  });

  test("invalidates Public Subpath discovery when a wildcard directory gains an entry", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-subpaths-test-")
    );

    const addedDeclaration = nodePath.join(
      getFixture().resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "conditional",
      "dist",
      "patterns",
      "green.d.ts"
    );

    const cliArguments = [
      "src/cli.ts",
      "subpaths",
      "@typepeek-fixture/conditional",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await writeFile(
        addedDeclaration,
        "export declare const greenPatternExport: string;\n"
      );

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        first.stdout.includes("@typepeek-fixture/conditional/patterns/green"),
        repeated.stdout.includes(
          "@typepeek-fixture/conditional/patterns/green"
        ),
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([false, true, true, false]);
    } finally {
      await Promise.all([
        rm(cacheDirectory, { force: true, recursive: true }),
        rm(addedDeclaration, { force: true }),
      ]);
    }
  });

  test("invalidates Public Subpath discovery when a missing wildcard directory appears", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-new-directory-test-")
    );

    const patternDirectory = nodePath.join(
      getFixture().resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "conditional",
      "dist",
      "patterns"
    );

    const redDeclaration = nodePath.join(patternDirectory, "red.d.ts");
    const originalDeclaration = await readFile(redDeclaration, "utf-8");

    const cliArguments = [
      "src/cli.ts",
      "subpaths",
      "@typepeek-fixture/conditional",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      await rm(patternDirectory, { recursive: true });
      const first = await runCommand(process.execPath, cliArguments, { env });
      const readdirResult5 = await readdir(cacheDirectory);
      expect(
        readdirResult5.some((name) => name.endsWith(".json"))
      ).toBeTruthy();

      const unchanged = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        unchanged.stdout,
        profilePhaseNames(unchanged.stderr).includes("inspection-cache-hit"),
      ]).toStrictEqual([first.stdout, true]);
      await mkdir(patternDirectory, { recursive: true });
      await writeFile(redDeclaration, originalDeclaration);

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        first.stdout.includes("@typepeek-fixture/conditional/patterns/red"),
        repeated.stdout.includes("@typepeek-fixture/conditional/patterns/red"),
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
      ]).toStrictEqual([false, true, true]);
    } finally {
      await mkdir(patternDirectory, { recursive: true });
      await Promise.all([
        writeFile(redDeclaration, originalDeclaration),
        rm(cacheDirectory, { force: true, recursive: true }),
      ]);
    }
  });

  test("invalidates when a consumed declaration changes at the same canonical path", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-declaration-test-")
    );

    const declarationPath = nodePath.join(
      getFixture().resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "compiled",
      "dist",
      "index.d.ts"
    );

    const originalDeclaration = await readFile(declarationPath, "utf-8");

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/compiled",
      "createWidget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await writeFile(
        declarationPath,
        originalDeclaration.replace(
          "createWidget(options?: WidgetOptions): string",
          "createWidget(options?: WidgetOptions): number"
        )
      );

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        Object.is(repeated.stdout, first.stdout),
        repeated.stdout.includes(": number"),
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([false, true, true, true]);
    } finally {
      await Promise.all([
        writeFile(declarationPath, originalDeclaration),
        rm(cacheDirectory, { force: true, recursive: true }),
      ]);
    }
  });

  test("invalidates when a consumed installed manifest changes", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-manifest-test-")
    );

    const manifestPath = nodePath.join(
      getFixture().resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "focused",
      "package.json"
    );

    const originalManifest = await readFile(manifestPath, "utf-8");

    const changedManifest = {
      ...decodeJson(mutableJsonObjectSchema, originalManifest),
      version: "2.0.1",
    };

    const cliArguments = [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/focused",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await writeFile(manifestPath, JSON.stringify(changedManifest));

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        Object.is(repeated.stdout, first.stdout),
        repeated.stdout.includes('"version":"2.0.1"'),
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
      ]).toStrictEqual([false, true, true]);
    } finally {
      await Promise.all([
        writeFile(manifestPath, originalManifest),
        rm(cacheDirectory, { force: true, recursive: true }),
      ]);
    }
  });
};
