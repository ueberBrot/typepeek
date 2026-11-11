import { defineConfig } from "taze";

export default defineConfig({
  includeLocked: true,
  maturityPeriod: 7,
  mode: "major",
  packageMode: {
    "@types/node": "minor",
    node: "minor",
    tsrs: "patch",
  },
});
