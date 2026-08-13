import { type ApplicationContext, buildApplication, buildCommand } from "@stricli/core";
import { resolve } from "node:path";

import {
  inspectExport,
  inspectExportSignatures,
  inspectInterfaceOverview,
} from "#typepeek/inspection";
import type { InspectionResult } from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { renderJsonOutcome } from "#typepeek/json-rendering";
import { renderInspection } from "#typepeek/terminal-rendering";

import packageJson from "../package.json" with { type: "json" };

interface CliOptions {
  readonly access: "import" | "require";
  readonly context: string;
  readonly export?: string;
  readonly json: boolean;
  readonly signaturesOnly: boolean;
  readonly subpaths: boolean;
}

const rootCommand = buildCommand<CliOptions, [string], ApplicationContext>({
  async func(options, specifier) {
    return runCliInspection(this, options, specifier);
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
        brief: "Module Export to inspect after discovering it in the overview.",
      },
      json: {
        kind: "boolean",
        default: false,
        withNegated: false,
        brief: "Emit one pre-stable structured Inspection Outcome as JSON.",
      },
      signaturesOnly: {
        kind: "boolean",
        default: false,
        withNegated: false,
        brief: "Inspect only call and construct signatures; requires --export.",
      },
      subpaths: {
        kind: "boolean",
        default: false,
        withNegated: false,
        brief: "List every Public Subpath in the human Interface Overview.",
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

async function runCliInspection(
  context: ApplicationContext,
  options: CliOptions,
  specifier: string,
): Promise<Error | undefined> {
  const optionError = validateOptions(options);
  if (optionError !== undefined) {
    return optionError;
  }
  const outcome = await inspectCliRequest(options, specifier);
  return writeCliOutcome(context, options, outcome);
}

function inspectCliRequest(options: CliOptions, specifier: string): Promise<InspectionOutcome> {
  const request = {
    resolutionContext: options.context,
    specifier,
    accessStyle: options.access,
  } as const;
  if (options.export === undefined) {
    return inspectInterfaceOverview(request);
  }
  return (options.signaturesOnly ? inspectExportSignatures : inspectExport)({
    ...request,
    exportName: options.export,
  });
}

function writeCliOutcome(
  context: ApplicationContext,
  options: CliOptions,
  outcome: InspectionOutcome,
): Error | undefined {
  if (options.json) {
    writeJsonOutcome(context, outcome);
    return undefined;
  }
  if (outcome.status !== "success") {
    return new Error(`${outcome.status}: ${outcome.message}`);
  }
  const rendering = renderForCommand(outcome.result, options.subpaths);
  if (rendering instanceof Error) {
    return rendering;
  }
  context.process.stdout.write(`${rendering}\n`);
  return undefined;
}

function writeJsonOutcome(context: ApplicationContext, outcome: InspectionOutcome): void {
  const rendering = renderJsonOutcome(outcome);
  context.process.stdout.write(`${rendering.text}\n`);
  if (rendering.failed) {
    context.process.exitCode = 1;
  }
}

function parseAccessStyle(input: string): "import" | "require" {
  if (input === "import" || input === "require") {
    return input;
  }
  throw new Error('Access Style must be "import" or "require".');
}

function renderForCommand(
  result: InspectionResult,
  includePublicSubpaths: boolean,
): string | Error {
  try {
    return renderInspection(result, { includePublicSubpaths });
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      return new Error(`limit-exceeded: ${error.message}`);
    }
    throw error;
  }
}

function validateOptions(options: CliOptions): Error | undefined {
  return [
    signaturesOnlyOptionError(options),
    subpathsJsonOptionError(options),
    subpathsExportOptionError(options),
  ].find((error) => error !== undefined);
}

function signaturesOnlyOptionError(options: CliOptions): Error | undefined {
  return options.signaturesOnly && options.export === undefined
    ? new Error("--signatures-only requires --export.")
    : undefined;
}

function subpathsJsonOptionError(options: CliOptions): Error | undefined {
  return options.subpaths && options.json
    ? new Error("--subpaths cannot be combined with --json.")
    : undefined;
}

function subpathsExportOptionError(options: CliOptions): Error | undefined {
  return options.subpaths && options.export !== undefined
    ? new Error("--subpaths cannot be combined with --export.")
    : undefined;
}

export const app = buildApplication(rootCommand, {
  name: "typepeek",
  scanner: {
    caseStyle: "allow-kebab-for-camel",
  },
  versionInfo: {
    currentVersion: packageJson.version,
  },
});
