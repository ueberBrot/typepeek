import { buildApplication, buildCommand } from "@stricli/core";
import { resolve } from "node:path";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";
import { renderInspection } from "#typepeek/terminal-rendering";

import packageJson from "../package.json" with { type: "json" };

const rootCommand = buildCommand<{ context: string; export?: string }, [string]>({
  async func({ context, export: exportName }, specifier) {
    const outcome =
      exportName === undefined
        ? await inspectInterfaceOverview({
            resolutionContext: context,
            specifier,
          })
        : await inspectExport({
            resolutionContext: context,
            specifier,
            exportName,
          });
    if (outcome.status !== "success") {
      return new Error(`${outcome.status}: ${outcome.message}`);
    }

    this.process.stdout.write(`${renderInspection(outcome.result)}\n`);
  },
  parameters: {
    flags: {
      context: {
        kind: "parsed",
        parse: resolve,
        default: ".",
        brief: "Resolution Context used to locate the installed Package Module.",
      },
      export: {
        kind: "parsed",
        parse: (input) => input,
        optional: true,
        brief: "Module Export to inspect in focus.",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (input) => input,
          brief: "Package-root or Public Subpath Specifier to inspect.",
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
