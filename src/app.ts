import { buildApplication, buildCommand } from "@stricli/core";

import packageJson from "../package.json" with { type: "json" };

const rootCommand = buildCommand({
  func() {
    this.process.stdout.write("Typepeek is ready.\n");
  },
  parameters: {},
  docs: {
    brief: "Describe the TypeScript-visible Public Interface of Inspectable Modules.",
  },
});

export const app = buildApplication(rootCommand, {
  name: "typepeek",
  versionInfo: {
    currentVersion: packageJson.version,
  },
});
