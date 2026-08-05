import { buildApplication, buildCommand } from "@stricli/core";
import { resolve } from "node:path";

import { inspectInterfaceOverview } from "#typepeek/inspection";

import packageJson from "../package.json" with { type: "json" };

const rootCommand = buildCommand<{ context: string }, [string]>({
  async func({ context }, specifier) {
    const outcome = await inspectInterfaceOverview({
      resolutionContext: context,
      specifier,
    });
    if (outcome.status !== "success") {
      return new Error(`${outcome.status}: ${outcome.message}`);
    }

    const { moduleExports, packageIdentity } = outcome.result;
    const version = packageIdentity.version === undefined ? "" : `@${packageIdentity.version}`;
    this.process.stdout.write(
      [
        "Interface Overview",
        `Specifier: ${outcome.result.specifier}`,
        `Package: ${packageIdentity.name}${version}`,
        `Module Exports (${moduleExports.length}):`,
        ...moduleExports.map(({ name }) => `- ${name}`),
        "",
      ].join("\n"),
    );
  },
  parameters: {
    flags: {
      context: {
        kind: "parsed",
        parse: resolve,
        default: ".",
        brief: "Resolution Context used to locate the installed Package Module.",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (input) => input,
          brief: "Package-root Specifier to inspect.",
          placeholder: "specifier",
        },
      ],
    },
  },
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
