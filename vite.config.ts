import { defineConfig } from "vite-plus";

export default defineConfig({
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
    attw: {
      level: "error",
      profile: "esm-only",
    },
    entry: ["src/index.ts", "src/cli.ts", "src/inspection/analysis-worker.ts"],
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
        // Preserve the known backlog while rejecting new findings in every category.
        command: [
          "fallow dead-code --baseline fallow-baselines/dead-code.json",
          "fallow dupes --baseline fallow-baselines/dupes.json",
          "fallow health --baseline fallow-baselines/health.json",
        ],
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
  },
});
