import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import ts from "@typescript/typescript6";
import { Predicate, Schema } from "effect";
import ultraciteFormat from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import ultraciteCore from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import ultraciteVitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

import { readStandardGlobalCatalog } from "./src/inspection/standard-global-catalog.ts";
import { decodeJson } from "./src/json-data.ts";

const presetImportOrder = ultraciteFormat.sortImports;

if (!Predicate.isReadonlyObject(presetImportOrder)) {
  throw new Error("Ultracite must provide import-sorting options.");
}

const documentationAndQuality = selectJsPlugins(["github", "sonarjs", "tsdoc"]);

const packageManifest = decodeJson(
  Schema.Struct({
    version: Schema.mutableKey(Schema.String),
  }),
  readFileSync(new URL("package.json", import.meta.url), "utf-8")
);

const packageVersionDefine = {
  "globalThis.__TYPEPEEK_COMPILER_VERSION__": JSON.stringify(ts.version),
  "globalThis.__TYPEPEEK_STANDARD_GLOBALS__": JSON.stringify(
    readStandardGlobalCatalog()
  ),
  "globalThis.__TYPEPEEK_VERSION__": JSON.stringify(packageManifest.version),
};

const releaseProfileAdapter = fileURLToPath(
  new URL("src/inspection/performance-profile-disabled.ts", import.meta.url)
);

const compilerRuntimeAdapter = fileURLToPath(
  new URL("src/inspection/compiler-runtime.ts", import.meta.url)
);

// Explicit inputs avoid tracing conflicts with the native checker subprocesses.
const validationInputs = [
  "src/**",
  "tests/**",
  "benchmarks/**",
  "docs/**",
  "assets/**",
  ".github/**",
  ".changeset/**",
  "*.ts",
  "*.json",
  "*.jsonc",
  "*.md",
  "*.yaml",
  ".fallowrc.jsonc",
  ".node-version",
];

const inspectionCoreChunk = function inspectionCoreChunk(
  moduleId: string
): string | undefined {
  return moduleId.replaceAll("\\", "/").endsWith("/src/inspection/protocol.ts")
    ? "inspection-outcome-codec"
    : undefined;
};

export default defineConfig({
  build: {
    lib: {
      entry: {
        cli: "src/cli.ts",
        "inspection/analysis-process-entry":
          "src/inspection/analysis-process-entry.ts",
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    outDir: ".vite-plus/build",
    rolldownOptions: {
      external: [/^node:/u, "@stricli/core", /^effect(?:\/|$)/u, "execa"],
      output: {
        // analysis-process.ts resolves the worker relative to a shared chunk,
        // so shared chunks must stay at the output root.
        chunkFileNames: "[name]-[hash].js",
        manualChunks: inspectionCoreChunk,
      },
    },
    sourcemap: true,
  },
  define: packageVersionDefine,
  fmt: {
    ...ultraciteFormat,
    ignorePatterns: [...(ultraciteFormat.ignorePatterns ?? []), ".agents/**"],
    sortImports: {
      ...presetImportOrder,
      customGroups: [
        { elementNamePattern: ["#typepeek/**"], groupName: "typepeek" },
      ],
      groups: [
        "builtin",
        "external",
        "typepeek",
        ["parent", "sibling", "index"],
        ["side_effect_style", "style"],
        "unknown",
      ],
      newlinesBetween: true,
    },
  },
  lint: {
    env: { node: true },
    extends: [
      ultraciteCore,
      documentationAndQuality,
      ultraciteVitest,
      antiSlop,
      effectRecommended,
    ],
    ignorePatterns: [...(ultraciteCore.ignorePatterns ?? []), ".agents/**"],
    jsPlugins: [
      { name: "github", specifier: "eslint-plugin-github" },
      { name: "sonarjs", specifier: "eslint-plugin-sonarjs" },
      { name: "tsdoc", specifier: "eslint-plugin-tsdoc" },
      ...(antiSlop.jsPlugins ?? []),
    ],
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
    // Register the Effect adapters as test blocks so assertion rules also cover them.
    overrides: [
      {
        files: ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
        rules: {
          "vitest/expect-expect": [
            "error",
            {
              additionalTestBlockFunctions: [
                "it",
                "it.each",
                "scopedIt",
                "liveIt",
              ],
            },
          ],
          "vitest/no-standalone-expect": [
            "error",
            {
              additionalTestBlockFunctions: [
                "it",
                "it.each",
                "scopedIt",
                "liveIt",
              ],
            },
          ],
        },
      },
    ],
  },
  pack: {
    alias: {
      "#typepeek/inspection/performance-profile": releaseProfileAdapter,
      "@typescript/typescript6": compilerRuntimeAdapter,
    },
    define: packageVersionDefine,
    // Apply the local compiler loader alias before dependency externalization.
    deps: {
      alwaysBundle: ["@typescript/typescript6"],
      resolveDepSubpath: true,
    },
    // This package exposes CLI binaries; validation checks types separately.
    dts: false,
    entry: ["src/cli.ts", "src/inspection/analysis-process-entry.ts"],
    format: ["esm"],
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    outputOptions: { manualChunks: inspectionCoreChunk },
    platform: "node",
    publint: {
      level: "error",
      strict: true,
    },
    sourcemap: true,
    unused: {
      ignore: {
        dependencies: ["@typescript/typescript6", "execa"],
      },
      level: "error",
    },
  },
  // Packaged builds disable phase tracing.
  resolve: {
    alias: {
      "#typepeek/inspection/performance-profile": releaseProfileAdapter,
      "@typescript/typescript6": compilerRuntimeAdapter,
    },
  },
  run: {
    tasks: {
      benchmark: {
        cache: false,
        command: "node benchmarks/codex-discovery/run.ts",
      },
      "benchmark:smoke": {
        cache: false,
        command: "node tests/benchmark-package-smoke.ts",
      },
      build: {
        cache: {
          input: [{ auto: true }, "!.vite-plus/build/**"],
          output: [".vite-plus/build/**"],
        },
        command: "vp build",
      },
      "build-smoke": {
        cache: { output: [] },
        command: "node tests/build-output-smoke.ts",
        dependsOn: ["build"],
      },
      check: {
        cache: { input: validationInputs, output: [] },
        command: "vp check",
      },
      dependencies: {
        cache: false,
        command: "taze",
      },
      "dependencies:update": {
        cache: false,
        command: "taze --interactive --write",
      },
      "effect-check": {
        cache: { input: validationInputs, output: [] },
        command: "effect-tsgo diagnostics --project tsconfig.json --strict",
      },
      fallow: {
        cache: false,
        command: [
          "fallow dead-code",
          "fallow dupes",
          "fallow health --hotspots --file-scores --min-score 75",
        ],
      },
      pack: {
        cache: { input: [{ auto: true }, "!dist/**"], output: ["dist/**"] },
        command: "vp pack",
      },
      "package-smoke": {
        cache: { output: [] },
        command: "node tests/package-output-smoke.ts",
        dependsOn: ["pack"],
      },
      test: {
        cache: { input: validationInputs, output: [] },
        command: "vp test --maxWorkers=2",
      },
      validate: {
        cache: false,
        command: [
          "vp run check",
          "vp run effect-check",
          "vp run fallow",
          "vp run test",
          "vp run build-smoke",
          "vp run package-smoke",
          "vp run benchmark:smoke",
        ],
      },
    },
  },
  staged: {
    "*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}": "vp check --fix",
    "*.{json,jsonc,md,yaml,yml}": "vp fmt --no-error-on-unmatched-pattern",
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
