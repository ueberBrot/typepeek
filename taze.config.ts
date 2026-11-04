import { defineConfig } from "taze";

export default defineConfig({
  includeLocked: true,
  // Keep the seven-day package update window aligned with pnpm-workspace.yaml.
  maturityPeriod: 7,
  packageMode: {
    "/.*/": "major",
    "@types/node": "minor",
    "@typescript/typescript6": "minor",
    node: "minor",
  },
});
