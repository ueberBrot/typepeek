import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import { Predicate, Schema } from "effect";
import ultraciteFormat from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import ultraciteCore from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import ultraciteVitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

import { COMPILER_VERSION } from "./src/inspection/compiler/compiler-distribution.ts";
import { readStandardGlobalCatalog } from "./src/inspection/compiler/standard-global-catalog.ts";
import { decodeJson } from "./src/shared/json-data.ts";

const presetImportOrder = ultraciteFormat.sortImports;

if (!Predicate.isReadonlyObject(presetImportOrder)) {
  throw new Error("Ultracite must provide import-sorting options.");
}

const documentationAndQuality = selectJsPlugins(["github", "sonarjs", "tsdoc"]);

const testFileQualityRules = documentationAndQuality.overrides?.[0]?.rules;
const testFileAssertionRules = ultraciteVitest.overrides?.[0]?.rules;

if (
  testFileQualityRules === undefined ||
  testFileAssertionRules === undefined
) {
  throw new Error("Ultracite must provide test quality and assertion rules.");
}

const packageManifest = decodeJson(
  Schema.Struct({
    version: Schema.mutableKey(Schema.String),
  }),
  readFileSync(new URL("package.json", import.meta.url), "utf-8")
);

const packageVersionDefine = {
  "globalThis.__TYPEPEEK_COMPILER_VERSION__": JSON.stringify(COMPILER_VERSION),
  "globalThis.__TYPEPEEK_STANDARD_GLOBALS__": JSON.stringify(
    readStandardGlobalCatalog()
  ),
  "globalThis.__TYPEPEEK_VERSION__": JSON.stringify(packageManifest.version),
};

const releaseProfileAdapter = fileURLToPath(
  new URL(
    "src/inspection/execution/performance-profile-disabled.ts",
    import.meta.url
  )
);

const effectBarrel = fileURLToPath(import.meta.resolve("effect")).replaceAll(
  "\\",
  "/"
);

// Tree-shake the barrel while keeping the selected public modules external.
const effectSubpathImports = {
  name: "effect-subpath-imports",
  resolveId(specifier: string, importer: string | undefined) {
    if (
      importer?.replaceAll("\\", "/") === effectBarrel &&
      specifier.startsWith("./") &&
      specifier.endsWith(".js")
    ) {
      return {
        external: true,
        id: `effect/${specifier.slice(2, -3)}`,
        moduleSideEffects: false,
      };
    }

    return null;
  },
};

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
  return moduleId
    .replaceAll("\\", "/")
    .endsWith("/src/inspection/model/protocol.ts")
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
      external: [
        /^node:/u,
        /^effect\//u,
        /^@effect\/platform-node-shared(?:\/|$)/u,
        /^tsrs(?:\/|$)/u,
        "semver",
      ],
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
      typeCheck: false,
    },
    overrides: [
      {
        // Imported suites share their owner's fixture and are not discovery roots.
        files: ["**/*.test.suite.ts"],
        plugins: ["vitest"],
        rules: {
          ...testFileQualityRules,
          ...testFileAssertionRules,
          "github/filenames-match-regex": [
            "error",
            "^[a-z0-9-]+\\.test\\.suite$",
          ],
          "vitest/consistent-test-filename": [
            "error",
            { pattern: ".*\\.test(?:\\.suite)?\\.[tj]sx?$" },
          ],
        },
      },
      {
        // Register the Effect adapters as test blocks so assertion rules also cover them.
        files: [
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
          "**/*.test.suite.ts",
        ],
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
    rules: {
      "import/no-namespace": "error",
    },
  },
  pack: {
    alias: {
      "#typepeek/inspection/execution/performance-profile":
        releaseProfileAdapter,
    },
    define: packageVersionDefine,
    // Keep SDK subpath imports external and resolvable in installed consumers.
    deps: {
      alwaysBundle: /^effect$/u,
      onlyBundle: ["effect"],
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
    plugins: [effectSubpathImports],
    publint: {
      level: "error",
      strict: true,
    },
    sourcemap: true,
    unused: {
      level: "error",
    },
  },
  plugins: [{ ...effectSubpathImports, enforce: "pre" }],
  // Packaged builds disable phase tracing.
  resolve: {
    alias: {
      "#typepeek/inspection/execution/performance-profile":
        releaseProfileAdapter,
    },
  },
  run: {
    tasks: {
      benchmark: {
        cache: false,
        command: "node benchmarks/codex-discovery/run.ts",
      },
      "benchmark:matrix": {
        cache: false,
        command: "node benchmarks/codex-discovery/matrix.ts",
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
        command: ["tsrs --noEmit -p tsconfig.json", "vp check"],
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
        command: "node tests/effect-diagnostics.ts",
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
      sandbox: {
        cache: false,
        command: "node benchmarks/harness/run.ts",
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
    setupFiles: ["tests/native-compiler-cleanup.ts"],
    testTimeout: 30_000,
  },
});
