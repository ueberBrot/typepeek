import {
  type ApplicationContext,
  buildApplication,
  buildCommand,
  buildRouteMap,
} from "@stricli/core";
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

interface InspectionTargetOptions {
  readonly access: "import" | "require";
  readonly context: string;
  readonly json: boolean;
}

interface OverviewOptions extends InspectionTargetOptions {
  readonly subpaths: boolean;
}

const inspectionTargetFlags = {
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
  json: {
    kind: "boolean",
    default: false,
    withNegated: false,
    brief: "Emit one pre-stable structured Inspection Outcome as JSON.",
  },
} as const;

const specifierParameter = {
  parse: (input: string) => input,
  brief: "Package-root or Public Subpath Specifier to inspect.",
  placeholder: "specifier",
} as const;

const exportNameParameter = {
  parse: (input: string) => input,
  brief: "Exact Module Export name to inspect.",
  placeholder: "export-name",
} as const;

const overviewCommand = buildCommand<OverviewOptions, [string], ApplicationContext>({
  async func(options, specifier) {
    const optionError = subpathsJsonOptionError(options);
    if (optionError !== undefined) {
      return optionError;
    }
    const outcome = await inspectInterfaceOverview(inspectionRequest(options, specifier));
    return writeCliOutcome(this, options, outcome, { includePublicSubpaths: options.subpaths });
  },
  parameters: {
    flags: {
      ...inspectionTargetFlags,
      subpaths: {
        kind: "boolean",
        default: false,
        withNegated: false,
        brief: "List every Public Subpath in the human Interface Overview.",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [specifierParameter],
    },
  },
  docs: {
    brief: "Index the Module Exports and Public Subpaths of one Inspectable Module.",
    fullDescription:
      "Example: typepeek overview zod --context . Use --json for one structured Inspection Outcome.",
  },
});

const exportCommand = buildCommand<InspectionTargetOptions, [string, string], ApplicationContext>({
  async func(options, specifier, exportName) {
    const outcome = await inspectExport({
      ...inspectionRequest(options, specifier),
      exportName,
    });
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportNameParameter],
    },
  },
  docs: {
    brief: "Inspect one Module Export with declarations and bounded Supporting Types.",
    fullDescription:
      "Example: typepeek export zod ZodError --context . Use it when you need declarations or Supporting Types.",
  },
});

const signaturesCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  async func(options, specifier, exportName) {
    const outcome = await inspectExportSignatures({
      ...inspectionRequest(options, specifier),
      exportName,
    });
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportNameParameter],
    },
  },
  docs: {
    brief: "Inspect only the public call and construct signatures of one Module Export.",
    fullDescription:
      "Example: typepeek signatures arktype type --context . --json emits structured type parameters, parameters, and return semantics.",
  },
});

const rootRoute = buildRouteMap({
  routes: {
    overview: overviewCommand,
    export: exportCommand,
    signatures: signaturesCommand,
  },
  defaultCommand: "overview",
  docs: {
    brief: "Describe the TypeScript-visible Public Interface of Inspectable Modules.",
    fullDescription:
      "Use overview to discover exports, signatures to inspect parameters, or export for declarations and Supporting Types. Command flags follow the command name.",
  },
});

function inspectionRequest(options: InspectionTargetOptions, specifier: string) {
  return {
    resolutionContext: options.context,
    specifier,
    accessStyle: options.access,
  } as const;
}

function writeCliOutcome(
  context: ApplicationContext,
  options: InspectionTargetOptions,
  outcome: InspectionOutcome,
  renderingOptions: { readonly includePublicSubpaths?: boolean } = {},
): Error | undefined {
  if (options.json) {
    writeJsonOutcome(context, outcome);
    return undefined;
  }
  if (outcome.status !== "success") {
    return new Error(`${outcome.status}: ${outcome.message}`);
  }
  const rendering = renderForCommand(outcome.result, renderingOptions);
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
  options: { readonly includePublicSubpaths?: boolean },
): string | Error {
  try {
    return renderInspection(result, options);
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      return new Error(`limit-exceeded: ${error.message}`);
    }
    throw error;
  }
}

function subpathsJsonOptionError(options: OverviewOptions): Error | undefined {
  return options.subpaths && options.json
    ? new Error("--subpaths cannot be combined with --json.")
    : undefined;
}

export const app = buildApplication(rootRoute, {
  name: "typepeek",
  scanner: {
    allowArgumentEscapeSequence: true,
    caseStyle: "allow-kebab-for-camel",
  },
  versionInfo: {
    currentVersion: packageJson.version,
  },
});
