import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const packageManifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { readonly version: string };
const packageVersionDefine = {
  __TYPEPEEK_VERSION__: JSON.stringify(packageManifest.version),
};

const releaseProfileAdapter = fileURLToPath(
  new URL("./src/inspection/performance-profile-disabled.ts", import.meta.url),
);

function inspectionCoreChunk(moduleId: string): string | undefined {
  return moduleId.replaceAll("\\", "/").endsWith("/src/inspection/protocol.ts")
    ? "inspection-outcome-codec"
    : undefined;
}

export default defineConfig({
  define: packageVersionDefine,
  // Phase tracing is repository diagnostics, not part of the distributed CLI.
  resolve: {
    alias: {
      "#typepeek/inspection/performance-profile": releaseProfileAdapter,
    },
  },
  build: {
    lib: {
      entry: {
        cli: "src/cli.ts",
        "inspection-api": "src/inspection-api.ts",
        "inspection/analysis-process-entry": "src/inspection/analysis-process-entry.ts",
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    outDir: ".vite-plus/build",
    rolldownOptions: {
      external: [/^node:/u, "@stricli/core", "@typescript/typescript6", "arktype", "execa"],
      output: {
        // analysis-process.ts resolves the emitted worker relative to a shared
        // implementation chunk, so shared chunks deliberately remain at root.
        chunkFileNames: "[name]-[hash].js",
        manualChunks: inspectionCoreChunk,
      },
    },
    sourcemap: true,
  },
  fmt: {
    ignorePatterns: [".agents/**", "dist/**"],
    overrides: [
      {
        files: ["*.jsonc", "**/*.jsonc"],
        options: {
          trailingComma: "none",
        },
      },
    ],
    sortImports: {
      customGroups: [
        {
          groupName: "typepeek",
          elementNamePattern: ["#typepeek/**"],
        },
      ],
      groups: [
        ["builtin", "external"],
        "typepeek",
        ["parent", "sibling", "index"],
        ["side_effect_style", "style"],
        "unknown",
      ],
      newlinesBetween: true,
    },
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: [".agents/**", "dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    alias: {
      "#typepeek/inspection/performance-profile": releaseProfileAdapter,
    },
    entry: ["src/cli.ts", "src/inspection-api.ts", "src/inspection/analysis-process-entry.ts"],
    dts: true,
    define: packageVersionDefine,
    format: ["esm"],
    outExtensions: () => ({
      js: ".js",
      dts: ".d.ts",
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
  run: {
    tasks: {
      check: {
        command: "vp check",
        output: [],
      },
      build: {
        command: "vp build",
        input: [{ auto: true }, "!.vite-plus/build/**"],
        output: [".vite-plus/build/**"],
      },
      "build-smoke": {
        command: "node tests/build-output-smoke.ts",
        dependsOn: ["build"],
        output: [],
      },
      pack: {
        command: "vp pack",
        input: [{ auto: true }, "!dist/**"],
        output: ["dist/**"],
      },
      fallow: {
        command: "fallow",
        cache: false,
      },
      dependencies: {
        command: "taze",
        cache: false,
      },
      "dependencies:update": {
        command: "taze --interactive --write",
        cache: false,
      },
      "package-smoke": {
        command: "node tests/package-output-smoke.ts",
        dependsOn: ["pack"],
        output: [],
      },
      "benchmark:source": {
        command: "node benchmarks/inspection-latency.ts --adapter source",
        output: [],
      },
      "benchmark:build": {
        command: "node benchmarks/inspection-latency.ts --adapter build",
        dependsOn: ["build"],
        output: [],
      },
      "benchmark:package": {
        command: "node benchmarks/inspection-latency.ts --adapter package",
        dependsOn: ["pack"],
        output: [],
      },
      test: {
        command: "vp test",
        output: [],
      },
      validate: {
        command: [
          "vp run check",
          "vp run fallow",
          "vp run test",
          "vp run build-smoke",
          "vp run package-smoke",
        ],
      },
    },
  },
  staged: {
    "*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}": "vp check --fix",
    "*.{json,jsonc,md,yaml,yml}": "vp fmt",
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
