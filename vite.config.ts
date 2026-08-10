import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    lib: {
      entry: {
        cli: "src/cli.ts",
        "analysis-process-entry": "src/inspection/analysis-process-entry.ts",
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    outDir: ".vite-plus/build",
    rolldownOptions: {
      external: [/^node:/u, "@stricli/core", "@typescript/typescript6", "arktype", "execa"],
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
    entry: ["src/cli.ts", "src/inspection/analysis-process-entry.ts"],
    dts: true,
    format: ["esm"],
    outExtensions: () => ({
      js: ".js",
      dts: ".d.ts",
    }),
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
      test: {
        command: "vp test",
        output: [],
      },
      validate: {
        command: ["vp run check", "vp run fallow", "vp run test", "vp run package-smoke"],
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
