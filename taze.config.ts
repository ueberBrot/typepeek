import { defineConfig } from "taze";

export default defineConfig({
  includeLocked: true,
  packageMode: {
    "@types/node": "minor",
    "@typescript/typescript6": "minor",
    "/.*/": "major",
  },
});
