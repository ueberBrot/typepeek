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
  INSPECTION_PROTOCOL_VERSION,
  inspectCapabilities,
  invokeInspectionProtocol,
} from "#typepeek/inspection";
import type {
  InspectionIntent,
  InspectionPlanQuery,
  InspectionRequestByIntent,
  InspectionResult,
} from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import {
  type InspectionPlanQueryIssue,
  readInspectionPlanQueries,
} from "#typepeek/inspection/inspection-plan-query";
import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { renderJsonOutcome } from "#typepeek/json-rendering";
import { serializeTerminalSafeJson, terminalSafeLine } from "#typepeek/output-safety";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";
import {
  internalProtocolWireError,
  readProtocolWireInput,
  renderProtocolWireValue,
} from "#typepeek/protocol-wire";
import { renderInspection, type TerminalRenderingOptions } from "#typepeek/terminal-rendering";

import { selectCliWorkspace } from "./cli-workspace.ts";

const MAX_CLI_DIAGNOSTIC_BYTES = 128 * 1_024;
const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;
const MAX_PLAN_QUERY_JSON_BYTES = 16 * 1_024;
const COMMON_OPTION_WIDTHS = new Map<string, number>([
  ["--json", 1],
  ["--pretty", 1],
  ["--access", 2],
  ["--workspace", 2],
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
  "compare",
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

interface CliOutputOptions {
  readonly json: boolean;
  readonly pretty: boolean;
}

interface InspectionTargetOptions extends CliOutputOptions {
  readonly access: "import" | "require";
  readonly workspace?: string;
}

interface CliInspectionTargetRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle: "import" | "require";
}

interface ComparisonOptions extends CliOutputOptions {
  readonly beforeAccess: "import" | "require";
  readonly afterAccess: "import" | "require";
  readonly beforeWorkspace?: string;
  readonly afterWorkspace?: string;
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
  workspace: {
    kind: "parsed",
    parse: resolve,
    optional: true,
    placeholder: "path",
    brief: "Consuming workspace from which Typepeek resolves the package.",
  },
  json: {
    kind: "boolean",
    default: false,
    withNegated: false,
    brief: "Emit structured JSON for agents and pipelines.",
  },
  pretty: {
    kind: "boolean",
    default: false,
    withNegated: false,
    brief: "Indent JSON output for human readability; requires --json.",
  },
} as const;

const specifierParameter = {
  parse: (input: string) => input,
  brief: "Package root, Public Subpath, or Node Platform Module Specifier to inspect.",
  placeholder: "specifier",
} as const;

const beforeSpecifierParameter = {
  ...specifierParameter,
  brief: "Package root, Public Subpath, or Node Platform Module Specifier for the before side.",
  placeholder: "before-specifier",
} as const;

const afterSpecifierParameter = {
  ...specifierParameter,
  brief: "Package root, Public Subpath, or Node Platform Module Specifier for the after side.",
  placeholder: "after-specifier",
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
    return runCliTargetInspection(
      this,
      "interface-overview",
      options,
      specifier,
      (target) => target,
      {
        includePublicSubpaths: options.subpaths,
        ...(options.match === undefined ? {} : { moduleExportMatch: options.match }),
      },
    );
  },
  parameters: {
    flags: {
      ...inspectionTargetFlags,
      match: {
        kind: "parsed",
        parse: (input: string) => input,
        optional: true,
        placeholder: "substring",
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
      "Example: typepeek overview zod. Use --json for one structured Inspection Outcome.",
  },
});

const exportCommand = buildCommand<InspectionTargetOptions, [string, string], ApplicationContext>({
  async func(options, specifier, exportName) {
    return runCliTargetInspection(this, "export-inspection", options, specifier, (target) => ({
      ...target,
      exportName,
    }));
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
      "Example: typepeek export zod ZodError. Use it when you need declarations or Supporting Types.",
  },
});

const signaturesCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  async func(options, specifier, exportName) {
    return runCliTargetInspection(this, "signature-inspection", options, specifier, (target) => ({
      ...target,
      exportName,
    }));
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
      "Example: typepeek signatures execa execa --json emits structured type parameters, parameters, and return semantics.",
  },
});

const declarationsCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  async func(options, specifier, exportName) {
    return runCliTargetInspection(this, "declaration-inspection", options, specifier, (target) => ({
      ...target,
      exportName,
    }));
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
      "Example: typepeek declarations zod ZodError avoids Signature and Supporting Type traversal.",
  },
});

const memberCommand = buildCommand<
  InspectionTargetOptions,
  [string, string, readonly string[]],
  ApplicationContext
>({
  async func(options, specifier, exportName, memberPath) {
    return runCliTargetInspection(this, "member-inspection", options, specifier, (target) => ({
      ...target,
      exportName,
      memberPath,
    }));
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
      "Example: typepeek member zod ZodError issues avoids unrelated declaration traversal.",
  },
});

const planCommand = buildCommand<
  InspectionTargetOptions,
  [string, readonly InspectionPlanQuery[]],
  ApplicationContext
>({
  async func(options, specifier, queries) {
    return runCliTargetInspection(this, "inspection-plan", options, specifier, (target) => ({
      ...target,
      queries,
    }));
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
      'Example: typepeek plan zod \'[{"intent":"interface-overview"}]\' --json returns one atomic outcome.',
  },
});

const searchCommand = buildCommand<InspectionTargetOptions, [string, string], ApplicationContext>({
  async func(options, specifier, query) {
    return runCliTargetInspection(this, "export-search", options, specifier, (target) => ({
      ...target,
      query,
    }));
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
      "Example: typepeek search zod error returns matching Module Export names and the complete count.",
  },
});

const subpathsCommand = buildCommand<InspectionTargetOptions, [string], ApplicationContext>({
  async func(options, specifier) {
    return runCliTargetInspection(
      this,
      "public-subpath-discovery",
      options,
      specifier,
      (target) => target,
    );
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
    fullDescription: "Example: typepeek subpaths zod lists only bounded manifest Public Subpaths.",
  },
});

const capabilitiesCommand = buildCommand<CliOutputOptions, [], ApplicationContext>({
  func(options) {
    this.process.stdout.write(
      `${serializeTerminalSafeJson(inspectCapabilities(), options.pretty)}\n`,
    );
  },
  parameters: {
    flags: { json: inspectionTargetFlags.json, pretty: inspectionTargetFlags.pretty },
    positional: {
      kind: "tuple",
      parameters: [],
    },
  },
  docs: {
    brief: "Print the Inspection Core capabilities as JSON.",
    fullDescription:
      "Capability output is always JSON. Pass --json to select machine-mode diagnostics; add --pretty for indented output.",
  },
});

const protocolCommand = buildCommand<Readonly<Record<never, never>>, [], ApplicationContext>({
  async func() {
    await runProtocolCommand(this);
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [],
    },
  },
  docs: {
    brief: "Invoke the Inspection Protocol with one bounded JSON request on stdin.",
    fullDescription:
      "Read one bounded JSON request from stdin and emit one compact JSON response on stdout. Run typepeek capabilities --json first to discover valid requests, response options, and recovery limits.",
  },
});

const compareCommand = buildCommand<ComparisonOptions, [string, string], ApplicationContext>({
  async func(options, beforeSpecifier, afterSpecifier) {
    const beforeResolutionContext = resolutionContextForSpecifier(
      beforeSpecifier,
      options.beforeWorkspace,
      "--before-workspace",
    );
    if (beforeResolutionContext instanceof Error) {
      return beforeResolutionContext;
    }
    const afterResolutionContext = resolutionContextForSpecifier(
      afterSpecifier,
      options.afterWorkspace,
      "--after-workspace",
    );
    if (afterResolutionContext instanceof Error) {
      return afterResolutionContext;
    }
    const outcome = await invokeCliInspection("public-interface-comparison", {
      before: {
        resolutionContext: beforeResolutionContext,
        specifier: beforeSpecifier,
        accessStyle: options.beforeAccess,
      },
      after: {
        resolutionContext: afterResolutionContext,
        specifier: afterSpecifier,
        accessStyle: options.afterAccess,
      },
    });
    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: {
      beforeAccess: {
        kind: "parsed",
        parse: parseAccessStyle,
        default: "import",
        placeholder: "import|require",
        brief: "Access Style for the before Resolution Variant.",
      },
      afterAccess: {
        kind: "parsed",
        parse: parseAccessStyle,
        default: "import",
        placeholder: "import|require",
        brief: "Access Style for the after Resolution Variant.",
      },
      beforeWorkspace: {
        kind: "parsed",
        parse: resolve,
        optional: true,
        placeholder: "path",
        brief: "Consuming workspace for the before Interface Overview.",
      },
      afterWorkspace: {
        kind: "parsed",
        parse: resolve,
        optional: true,
        placeholder: "path",
        brief: "Consuming workspace for the after Interface Overview.",
      },
      json: inspectionTargetFlags.json,
      pretty: inspectionTargetFlags.pretty,
    },
    positional: {
      kind: "tuple",
      parameters: [beforeSpecifierParameter, afterSpecifierParameter],
    },
  },
  docs: {
    brief: "Compare two complete Interface Overview indexes without merging variants.",
    fullDescription:
      "Example: typepeek compare zod zod --before-workspace old --after-workspace new compares installed versions directionally.",
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
    compare: compareCommand,
    capabilities: capabilitiesCommand,
    protocol: protocolCommand,
  },
  defaultCommand: "overview",
  docs: {
    brief: "Describe the TypeScript-visible Public Interface of Inspectable Modules.",
    fullDescription:
      "Start with overview to discover exports. Use search or subpaths for lighter discovery; declarations or member for narrow declaration questions; signatures for parameters; export for declarations and Supporting Types; plan to share one evidence snapshot; and compare to diff two overview indexes. Agents can run capabilities before invoking protocol through bounded stdin/stdout. Common flags may precede or follow an explicit inspection command.",
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
    currentVersion: TYPEPEEK_VERSION,
  },
});

/** Runs the CLI adapter and normalizes all process-facing behavior. */
export async function runCli(rawInputs: readonly string[]): Promise<void> {
  const session = new CliProcessSession();
  if (requestsPretty(rawInputs) && !requestsJson(rawInputs)) {
    session.process.stderr.write("--pretty requires --json.\n");
    session.process.exitCode = INVALID_INVOCATION_EXIT_CODE;
    session.complete(rawInputs);
    return;
  }
  const inputs = rawInputs.length === 0 ? ["--help"] : normalizeCommonOptionPlacement(rawInputs);
  await run(app, inputs, { process: session.process });
  session.complete(rawInputs);
}

async function runProtocolCommand(context: ApplicationContext): Promise<void> {
  try {
    const reading = await readProtocolWireInput(process.stdin);
    if (!reading.accepted) {
      writeProtocolWireValue(context, reading.error, INVALID_INVOCATION_EXIT_CODE);
      return;
    }
    const response = await invokeInspectionProtocol(reading.value);
    writeProtocolResponse(context, response);
  } catch {
    writeProtocolWireValue(
      context,
      internalProtocolWireError("unexpected-error"),
      INTERNAL_ERROR_EXIT_CODE,
    );
  }
}

function writeProtocolResponse(
  context: ApplicationContext,
  response: Awaited<ReturnType<typeof invokeInspectionProtocol>>,
): void {
  const exitCode = response.outcome.status === "success" ? 0 : INSPECTION_FAILURE_EXIT_CODE;
  if (!writeProtocolWireValue(context, response, exitCode)) {
    writeProtocolWireValue(context, protocolOutputLimitResponse(), INSPECTION_FAILURE_EXIT_CODE);
  }
}

function writeProtocolWireValue(
  context: ApplicationContext,
  value: unknown,
  exitCode: number,
): boolean {
  const rendering = renderProtocolWireValue(value);
  if (rendering === undefined) {
    return false;
  }
  context.process.stdout.write(rendering);
  context.process.exitCode = exitCode;
  return true;
}

function protocolOutputLimitResponse() {
  return {
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    outcome: {
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget: "json-output",
      message: "Inspection exceeded its protocol output limit.",
    },
  } as const;
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
    process.stdout.write(`${renderCliDiagnostic(diagnostic, requestsPretty(rawInputs))}\n`);
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

function renderCliDiagnostic(snapshot: CliDiagnosticSnapshot, pretty: boolean): string {
  const diagnostic: CliDiagnostic = {
    status: cliDiagnosticStatus(snapshot.exitCode),
    message: snapshot.exceeded ? cliDiagnosticLimitMessage() : snapshot.stderr.trimEnd(),
  };
  const rendered = serializeTerminalSafeJson(diagnostic, pretty);
  return Buffer.byteLength(rendered) <= MAX_CLI_DIAGNOSTIC_BYTES
    ? rendered
    : serializeTerminalSafeJson(
        {
          status: diagnostic.status,
          message: cliDiagnosticLimitMessage(),
        } satisfies CliDiagnostic,
        pretty,
      );
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
  return requestsFlag(inputs, "--json");
}

function requestsPretty(inputs: readonly string[]): boolean {
  return requestsFlag(inputs, "--pretty");
}

function requestsFlag(inputs: readonly string[], flag: "--json" | "--pretty"): boolean {
  for (const input of inputs) {
    if (input === "--") {
      return false;
    }
    if (input === flag) {
      return true;
    }
  }
  return false;
}

function inspectionRequest(options: InspectionTargetOptions, specifier: string) {
  const resolutionContext = resolutionContextForSpecifier(
    specifier,
    options.workspace,
    "--workspace",
  );
  if (resolutionContext instanceof Error) {
    return resolutionContext;
  }
  return {
    resolutionContext,
    specifier,
    accessStyle: options.access,
  } as const;
}

function resolutionContextForSpecifier(
  specifier: string,
  explicitWorkspace: string | undefined,
  workspaceFlag: "--workspace" | "--before-workspace" | "--after-workspace",
): string | InvalidInvocationError {
  const selection = selectCliWorkspace(specifier, explicitWorkspace, workspaceFlag);
  return selection instanceof Error ? new InvalidInvocationError(selection.message) : selection;
}

async function runCliTargetInspection<Intent extends InspectionIntent>(
  context: ApplicationContext,
  intent: Intent,
  options: InspectionTargetOptions,
  specifier: string,
  requestForTarget: (target: CliInspectionTargetRequest) => InspectionRequestByIntent[Intent],
  renderingOptions: TerminalRenderingOptions = {},
): Promise<Error | undefined> {
  const target = inspectionRequest(options, specifier);
  if (target instanceof Error) {
    return target;
  }
  const outcome = await invokeCliInspection(intent, requestForTarget(target));
  return writeCliOutcome(context, options, outcome, renderingOptions);
}

async function invokeCliInspection<Intent extends InspectionIntent>(
  intent: Intent,
  request: InspectionRequestByIntent[Intent],
): Promise<InspectionOutcome> {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent,
    request,
    ...(cliRequestUsesSignatureEvidence(intent, request)
      ? { response: { signatureEvidence: "both" } }
      : {}),
  });
  return response.outcome as InspectionOutcome;
}

function cliRequestUsesSignatureEvidence<Intent extends InspectionIntent>(
  intent: Intent,
  request: InspectionRequestByIntent[Intent],
): boolean {
  if (intent === "signature-inspection") {
    return true;
  }
  if (intent !== "inspection-plan") {
    return false;
  }
  return (request as InspectionRequestByIntent["inspection-plan"]).queries.some(
    (query) => query.intent === "signature-inspection",
  );
}

function writeCliOutcome(
  context: ApplicationContext,
  options: CliOutputOptions,
  outcome: InspectionOutcome,
  renderingOptions: TerminalRenderingOptions = {},
): Error | undefined {
  if (options.json) {
    writeJsonOutcome(context, outcome, options.pretty);
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

function writeJsonOutcome(
  context: ApplicationContext,
  outcome: InspectionOutcome,
  pretty: boolean,
): void {
  const rendering = renderJsonOutcome(outcome, pretty);
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
  const reading = readInspectionPlanQueries(parseInspectionPlanJson(input));
  if (!reading.accepted) {
    throw new Error(inspectionPlanQueryIssueMessage(reading.issue));
  }
  return reading.queries;
}

function parseInspectionPlanJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("Inspection Plan queries must be valid JSON.");
  }
}

function inspectionPlanQueryIssueMessage(issue: InspectionPlanQueryIssue): string {
  const messages = {
    "invalid-list": "Inspection Plan queries must contain from 1 through 16 entries.",
    "invalid-entry": "Each Inspection Plan query must be an object.",
    "unsupported-intent": "Each Inspection Plan query has an unsupported intent.",
    "invalid-search": "Each Export Search query requires a bounded non-empty query string.",
    "invalid-focused": "Each focused Inspection Plan query requires a string exportName.",
    "invalid-member": "Each Member Inspection query requires an exportName and memberPath.",
  } as const satisfies Readonly<Record<InspectionPlanQueryIssue, string>>;
  return messages[issue];
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
