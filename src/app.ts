import { buildApplication, buildCommand } from "@stricli/core";
import { resolve } from "node:path";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";
import type { InspectionResult } from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { renderInspection } from "#typepeek/terminal-rendering";

import packageJson from "../package.json" with { type: "json" };

const rootCommand = buildCommand<
  { access: "import" | "require"; context: string; export?: string },
  [string]
>({
  async func({ access, context, export: exportName }, specifier) {
    const outcome =
      exportName === undefined
        ? await inspectInterfaceOverview({
            resolutionContext: context,
            specifier,
            accessStyle: access,
          })
        : await inspectExport({
            resolutionContext: context,
            specifier,
            accessStyle: access,
            exportName,
          });
    if (outcome.status !== "success") {
      return new Error(`${outcome.status}: ${outcome.message}`);
    }

    const rendering = renderForCommand(outcome.result);
    if (rendering instanceof Error) {
      return rendering;
    }
    this.process.stdout.write(`${rendering}\n`);
  },
  parameters: {
    flags: {
      access: {
        kind: "parsed",
        parse: parseAccessStyle,
        default: "import",
        brief: "Access Style whose package conditions select the Resolution Variant.",
      },
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

function parseAccessStyle(input: string): "import" | "require" {
  if (input === "import" || input === "require") {
    return input;
  }
  throw new Error('Access Style must be "import" or "require".');
}

function renderForCommand(result: InspectionResult): string | Error {
  try {
    return renderInspection(result);
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      return new Error(`limit-exceeded: ${error.message}`);
    }
    throw error;
  }
}

export const app = buildApplication(rootCommand, {
  name: "typepeek",
  versionInfo: {
    currentVersion: packageJson.version,
  },
});
