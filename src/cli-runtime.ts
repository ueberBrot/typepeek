import {
  type ApplicationContext,
  buildApplication,
  buildCommand,
  buildRouteMap,
  run,
  type StricliProcess,
} from "@stricli/core";
import { resolve } from "node:path";

import {
  inspectExport,
  inspectExportDeclarations,
  inspectExportMember,
  inspectExportSearch,
  inspectExportSignatures,
  inspectCapabilities,
  inspectInterfaceOverview,
  inspectPlan,
  inspectPublicSubpaths,
} from "#typepeek/inspection";
import type { InspectionPlanQuery, InspectionResult } from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { renderJsonOutcome } from "#typepeek/json-rendering";
import { serializeTerminalSafeJson, terminalSafeLine } from "#typepeek/output-safety";
import { renderInspection, type TerminalRenderingOptions } from "#typepeek/terminal-rendering";

import packageJson from "../package.json" with { type: "json" };

const MAX_CLI_DIAGNOSTIC_BYTES = 128 * 1_024;
const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;
const MAX_PLAN_QUERY_JSON_BYTES = 16 * 1_024;
const COMMON_OPTION_WIDTHS = new Map<string, number>([
  ["--json", 1],
  ["--access", 2],
  ["--context", 2],
] as const);
const INSPECTION_COMMANDS = new Set([
  "overview",
  "export",
  "signatures",
  "plan",
  "search",
  "subpaths",
  "declarations",
  "member",
]);
const INVALID_INVOCATION_EXIT_CODES = new Set([-5, -4]);

interface CliDiagnostic {
  readonly status: "internal-error" | "invalid-invocation";
  readonly message: string;
}

interface CliDiagnosticSnapshot {
  readonly exitCode: number | string | undefined;
  readonly stderr: string;
  readonly exceeded: boolean;
}

interface InspectionTargetOptions {
  readonly access: "import" | "require";
  readonly context: string;
  readonly json: boolean;
}

interface OverviewOptions extends InspectionTargetOptions {
  readonly match?: string;
  readonly subpaths: boolean;
}

class InspectionFailureError extends Error {}
class InvalidInvocationError extends Error {}

class CliProcessSession {
  #capturedStderr = "";
  #capturedStderrBytes = 0;
  #exitState: { value: number | string | null } = { value: null };

  readonly process: StricliProcess;

  constructor() {
    const exitState = this.#exitState;
    this.process = {
      stdout: process.stdout,
      stderr: {
        write: (value) => this.#captureStderr(value),
        getColorDepth: () => 0,
      },
      env: readableEnvironment(),
      get exitCode() {
        return exitState.value;
      },
      set exitCode(value) {
        exitState.value = value;
      },
    };
  }

  complete(rawInputs: readonly string[]): void {
    const normalizedExitCode = normalizeExitCode(this.#exitState.value);
    if (this.#capturedStderr !== "" || this.#captureExceeded) {
      writeCapturedDiagnostic(rawInputs, {
        exitCode: normalizedExitCode,
        stderr: this.#capturedStderr,
        exceeded: this.#captureExceeded,
      });
    }
    process.exitCode = normalizedExitCode;
  }

  #captureStderr(value: string): void {
    const valueBytes = Buffer.byteLength(value);
    if (this.#capturedStderrBytes + valueBytes > MAX_CLI_DIAGNOSTIC_BYTES) {
      this.#capturedStderr = "";
      this.#capturedStderrBytes = MAX_CLI_DIAGNOSTIC_BYTES + 1;
      return;
    }
    this.#capturedStderr += value;
    this.#capturedStderrBytes += valueBytes;
  }

  get #captureExceeded(): boolean {
    return this.#capturedStderrBytes > MAX_CLI_DIAGNOSTIC_BYTES;
  }
}

const inspectionTargetFlags = {
  access: {
    kind: "parsed",
    parse: parseAccessStyle,
    default: "import",
    placeholder: "import|require",
    brief: "Access Style whose package conditions select the Resolution Variant.",
  },
  context: {
    kind: "parsed",
    parse: resolve,
    default: ".",
    brief: "Resolution Context from which Installed Evidence is visible.",
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
  brief: "Package root, Public Subpath, or Node Platform Module Specifier to inspect.",
  placeholder: "specifier",
} as const;

const exportNameParameter = {
  parse: (input: string) => input,
  brief: "Exact Module Export name to inspect.",
  placeholder: "export-name",
} as const;

const exportSearchQueryParameter = {
  parse: (input: string) => input,
  brief: "Case-insensitive substring to match against Module Export names.",
  placeholder: "query",
} as const;

const memberPathParameter = {
  parse: parseMemberPath,
  brief: "One exact Member name or a JSON string array for a nested Member path.",
  placeholder: "member-path",
} as const;

const inspectionPlanQueriesParameter = {
  parse: parseInspectionPlanQueries,
  brief: "Bounded JSON array of overview, focused, search, or subpath inspection queries.",
  placeholder: "queries-json",
} as const;

const overviewCommand = buildCommand<OverviewOptions, [string], ApplicationContext>({
  async func(options, specifier) {
    const optionError = overviewJsonOptionError(options);
    if (optionError !== undefined) {
      return optionError;
    }
    const outcome = await inspectInterfaceOverview(inspectionRequest(options, specifier));
    return writeCliOutcome(this, options, outcome, {
      includePublicSubpaths: options.subpaths,
      ...(options.match === undefined ? {} : { moduleExportMatch: options.match }),
    });
  },
  parameters: {
    flags: {
      ...inspectionTargetFlags,
      match: {
        kind: "parsed",
        parse: (input: string) => input,
        optional: true,
        brief: "Match Module Export names case-insensitively in human output.",
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

const declarationsCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  async func(options, specifier, exportName) {
    const outcome = await inspectExportDeclarations({
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
    brief: "Inspect only the declarations of one Module Export.",
    fullDescription:
      "Example: typepeek declarations zod ZodError --context . avoids Signature and Supporting Type traversal.",
  },
});

const memberCommand = buildCommand<
  InspectionTargetOptions,
  [string, string, readonly string[]],
  ApplicationContext
>({
  async func(options, specifier, exportName, memberPath) {
    const outcome = await inspectExportMember({
      ...inspectionRequest(options, specifier),
      exportName,
      memberPath,
    });
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportNameParameter, memberPathParameter],
    },
  },
  docs: {
    brief: "Inspect exactly one public Member path of a Module Export.",
    fullDescription:
      "Example: typepeek member zod ZodError issues --context . avoids unrelated declaration traversal.",
  },
});

const planCommand = buildCommand<
  InspectionTargetOptions,
  [string, readonly InspectionPlanQuery[]],
  ApplicationContext
>({
  async func(options, specifier, queries) {
    const outcome = await inspectPlan({
      ...inspectionRequest(options, specifier),
      queries,
    });
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, inspectionPlanQueriesParameter],
    },
  },
  docs: {
    brief: "Execute a bounded query list over one shared Installed Evidence snapshot.",
    fullDescription:
      'Example: typepeek plan zod \'[{"intent":"interface-overview"}]\' --context . --json returns one atomic outcome.',
  },
});

const searchCommand = buildCommand<InspectionTargetOptions, [string, string], ApplicationContext>({
  async func(options, specifier, query) {
    const outcome = await inspectExportSearch({
      ...inspectionRequest(options, specifier),
      query,
    });
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportSearchQueryParameter],
    },
  },
  docs: {
    brief: "Search the bounded Module Export index without returning an overview.",
    fullDescription:
      "Example: typepeek search zod error --context . returns matching Module Export names and the complete count.",
  },
});

const subpathsCommand = buildCommand<InspectionTargetOptions, [string], ApplicationContext>({
  async func(options, specifier) {
    const outcome = await inspectPublicSubpaths(inspectionRequest(options, specifier));
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter],
    },
  },
  docs: {
    brief: "Discover manifest Public Subpaths without materializing a TypeScript program.",
    fullDescription:
      "Example: typepeek subpaths zod --context . lists only bounded manifest Public Subpaths.",
  },
});

const capabilitiesCommand = buildCommand<Readonly<Record<never, never>>, [], ApplicationContext>({
  func() {
    this.process.stdout.write(`${serializeTerminalSafeJson(inspectCapabilities())}\n`);
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [],
    },
  },
  docs: {
    brief: "Print the versioned Inspection Core capabilities as JSON.",
  },
});

const rootRoute = buildRouteMap({
  routes: {
    overview: overviewCommand,
    export: exportCommand,
    signatures: signaturesCommand,
    plan: planCommand,
    search: searchCommand,
    subpaths: subpathsCommand,
    declarations: declarationsCommand,
    member: memberCommand,
    capabilities: capabilitiesCommand,
  },
  defaultCommand: "overview",
  docs: {
    brief: "Describe the TypeScript-visible Public Interface of Inspectable Modules.",
    fullDescription:
      "Use overview to discover exports; use search or subpaths for lighter discovery, declarations or member for narrow declaration questions, signatures for parameters, export for declarations and Supporting Types, plan to share one evidence snapshot, or capabilities to discover the adapter protocol. Common flags may precede or follow an explicit inspection command.",
  },
});

const app = buildApplication(rootRoute, {
  name: "typepeek",
  determineExitCode(error) {
    if (error instanceof InvalidInvocationError) {
      return INVALID_INVOCATION_EXIT_CODE;
    }
    return error instanceof InspectionFailureError
      ? INSPECTION_FAILURE_EXIT_CODE
      : INTERNAL_ERROR_EXIT_CODE;
  },
  scanner: {
    allowArgumentEscapeSequence: true,
    caseStyle: "allow-kebab-for-camel",
  },
  versionInfo: {
    currentVersion: packageJson.version,
  },
});

/** Runs the CLI adapter and normalizes all process-facing behavior. */
export async function runCli(rawInputs: readonly string[]): Promise<void> {
  const session = new CliProcessSession();
  const inputs = rawInputs.length === 0 ? ["--help"] : normalizeCommonOptionPlacement(rawInputs);
  await run(app, inputs, { process: session.process });
  session.complete(rawInputs);
}

function normalizeCommonOptionPlacement(inputs: readonly string[]): readonly string[] {
  const commandIndex = leadingCommonOptionsEnd(inputs);
  const command = inputs[commandIndex];
  return commandIndex > 0 && command !== undefined && INSPECTION_COMMANDS.has(command)
    ? [command, ...inputs.slice(0, commandIndex), ...inputs.slice(commandIndex + 1)]
    : inputs;
}

function leadingCommonOptionsEnd(inputs: readonly string[]): number {
  let index = 0;
  while (index < inputs.length) {
    const width = COMMON_OPTION_WIDTHS.get(String(inputs[index]));
    if (width === undefined) {
      return index;
    }
    if (inputs[index + width - 1] === undefined) {
      return 0;
    }
    index += width;
  }
  return index;
}

function normalizeExitCode(exitCode: number | string | null): number | string | undefined {
  if (typeof exitCode !== "number") {
    return normalizeNonNumberExitCode(exitCode);
  }
  if (exitCode >= 0) {
    return exitCode;
  }
  return normalizedNegativeExitCode(exitCode);
}

function normalizeNonNumberExitCode(exitCode: string | null): string | undefined {
  return exitCode === null ? undefined : exitCode;
}

function normalizedNegativeExitCode(exitCode: number): number {
  return INVALID_INVOCATION_EXIT_CODES.has(exitCode)
    ? INVALID_INVOCATION_EXIT_CODE
    : INTERNAL_ERROR_EXIT_CODE;
}

function writeCapturedDiagnostic(
  rawInputs: readonly string[],
  diagnostic: CliDiagnosticSnapshot,
): void {
  if (requestsJson(rawInputs)) {
    process.stdout.write(`${renderCliDiagnostic(diagnostic)}\n`);
    return;
  }
  process.stderr.write(renderHumanCliDiagnostic(diagnostic));
}

function readableEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function renderCliDiagnostic(snapshot: CliDiagnosticSnapshot): string {
  const diagnostic: CliDiagnostic = {
    status: cliDiagnosticStatus(snapshot.exitCode),
    message: snapshot.exceeded ? cliDiagnosticLimitMessage() : snapshot.stderr.trimEnd(),
  };
  const rendered = serializeTerminalSafeJson(diagnostic);
  return Buffer.byteLength(rendered) <= MAX_CLI_DIAGNOSTIC_BYTES
    ? rendered
    : serializeTerminalSafeJson({
        status: diagnostic.status,
        message: cliDiagnosticLimitMessage(),
      } satisfies CliDiagnostic);
}

function renderHumanCliDiagnostic(snapshot: CliDiagnosticSnapshot): string {
  if (!snapshot.exceeded) {
    const rendered = `${terminalSafeLine(snapshot.stderr.trimEnd())}\n`;
    if (Buffer.byteLength(rendered) <= MAX_CLI_DIAGNOSTIC_BYTES) {
      return rendered;
    }
  }
  return `${cliDiagnosticStatus(snapshot.exitCode)}: ${cliDiagnosticLimitMessage()}\n`;
}

function cliDiagnosticStatus(exitCode: number | string | undefined): CliDiagnostic["status"] {
  return exitCode === INVALID_INVOCATION_EXIT_CODE ? "invalid-invocation" : "internal-error";
}

function cliDiagnosticLimitMessage(): string {
  return "CLI diagnostic exceeded its output limit.";
}

function requestsJson(inputs: readonly string[]): boolean {
  for (const input of inputs) {
    if (input === "--") {
      return false;
    }
    if (input === "--json") {
      return true;
    }
  }
  return false;
}

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
  renderingOptions: TerminalRenderingOptions = {},
): Error | undefined {
  if (options.json) {
    writeJsonOutcome(context, outcome);
    return undefined;
  }
  if (outcome.status !== "success") {
    return new InspectionFailureError(terminalSafeLine(`${outcome.status}: ${outcome.message}`));
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
    context.process.exitCode = INSPECTION_FAILURE_EXIT_CODE;
  }
}

function parseAccessStyle(input: string): "import" | "require" {
  if (input === "import" || input === "require") {
    return input;
  }
  throw new Error('Access Style must be "import" or "require".');
}

function parseMemberPath(input: string): readonly string[] {
  const memberPath = readBoundedMemberPath(
    input.startsWith("[") ? parseMemberPathJson(input) : [input],
  );
  if (memberPath === undefined) {
    throw new Error("Member path must contain from 1 through 16 bounded non-empty segments.");
  }
  return memberPath;
}

function parseMemberPathJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("Member path must be a valid JSON string array.");
  }
}

function parseInspectionPlanQueries(input: string): readonly InspectionPlanQuery[] {
  if (Buffer.byteLength(input) > MAX_PLAN_QUERY_JSON_BYTES) {
    throw new Error("Inspection Plan query JSON exceeds its input limit.");
  }
  return readInspectionPlanQueryArray(parseInspectionPlanJson(input)).map(parseInspectionPlanQuery);
}

function parseInspectionPlanJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("Inspection Plan queries must be valid JSON.");
  }
}

function readInspectionPlanQueryArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error("Inspection Plan queries must contain from 1 through 16 entries.");
  }
  return value;
}

function parseInspectionPlanQuery(value: unknown): InspectionPlanQuery {
  if (!isPlainRecord(value)) {
    throw new Error("Each Inspection Plan query must be an object.");
  }
  const intent = value["intent"];
  if (!isInspectionPlanQueryIntent(intent)) {
    throw new Error("Each Inspection Plan query has an unsupported intent.");
  }
  return INSPECTION_PLAN_QUERY_PARSERS[intent](value);
}

type InspectionPlanQueryParser = (value: Readonly<Record<string, unknown>>) => InspectionPlanQuery;

const INSPECTION_PLAN_QUERY_INTENTS = new Set<InspectionPlanQuery["intent"]>([
  "interface-overview",
  "export-inspection",
  "signature-inspection",
  "export-search",
  "public-subpath-discovery",
  "declaration-inspection",
  "member-inspection",
]);

const INSPECTION_PLAN_QUERY_PARSERS = {
  "interface-overview": () => ({ intent: "interface-overview" }),
  "public-subpath-discovery": () => ({ intent: "public-subpath-discovery" }),
  "export-search": (value) => parseExportSearchInspectionPlanQuery(value["query"]),
  "export-inspection": (value) =>
    parseFocusedInspectionPlanQuery("export-inspection", value["exportName"]),
  "signature-inspection": (value) =>
    parseFocusedInspectionPlanQuery("signature-inspection", value["exportName"]),
  "declaration-inspection": (value) =>
    parseFocusedInspectionPlanQuery("declaration-inspection", value["exportName"]),
  "member-inspection": (value) => parseMemberInspectionPlanQuery(value),
} as const satisfies Readonly<Record<InspectionPlanQuery["intent"], InspectionPlanQueryParser>>;

function isInspectionPlanQueryIntent(value: unknown): value is InspectionPlanQuery["intent"] {
  return (
    typeof value === "string" &&
    INSPECTION_PLAN_QUERY_INTENTS.has(value as InspectionPlanQuery["intent"])
  );
}

function parseExportSearchInspectionPlanQuery(query: unknown): InspectionPlanQuery {
  if (typeof query !== "string" || query.length === 0 || Buffer.byteLength(query) > 256) {
    throw new Error("Each Export Search query requires a bounded non-empty query string.");
  }
  return { intent: "export-search", query };
}

function parseFocusedInspectionPlanQuery(
  intent: "export-inspection" | "signature-inspection" | "declaration-inspection",
  exportName: unknown,
): InspectionPlanQuery {
  if (typeof exportName !== "string") {
    throw new Error("Each focused Inspection Plan query requires a string exportName.");
  }
  return { intent, exportName };
}

function parseMemberInspectionPlanQuery(
  value: Readonly<Record<string, unknown>>,
): InspectionPlanQuery {
  const exportName = value["exportName"];
  const memberPath = readBoundedMemberPath(value["memberPath"]);
  if (typeof exportName !== "string" || memberPath === undefined) {
    throw new Error("Each Member Inspection query requires an exportName and memberPath.");
  }
  return { intent: "member-inspection", exportName, memberPath };
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderForCommand(
  result: InspectionResult,
  options: TerminalRenderingOptions,
): string | Error {
  try {
    return renderInspection(result, options);
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      return new InspectionFailureError(`limit-exceeded: ${error.message}`);
    }
    throw error;
  }
}

function overviewJsonOptionError(options: OverviewOptions): Error | undefined {
  if (!options.json) {
    return undefined;
  }
  if (options.subpaths) {
    return new InvalidInvocationError("--subpaths cannot be combined with --json.");
  }
  return options.match === undefined
    ? undefined
    : new InvalidInvocationError("--match cannot be combined with --json.");
}
