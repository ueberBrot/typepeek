import nodePath from "node:path";

import type { ApplicationContext, StricliProcess } from "@stricli/core";
import {
  buildApplication,
  help,
  buildCommand,
  buildRouteMap,
  run,
  version,
} from "@stricli/core";
import { Predicate, Schema } from "effect";

import type {
  InspectionIntent,
  InspectionPlanQuery,
  InspectionRequestByIntent,
  InspectionResult,
  MemberPath,
} from "#typepeek/inspection";
import {
  INSPECTION_PROTOCOL_VERSION,
  inspectCapabilities,
  invokeInspectionProtocol,
} from "#typepeek/inspection";
import { InspectionFailureError } from "#typepeek/inspection-failure-error";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { enforceInspectionOutcome } from "#typepeek/inspection/inspection-outcome-authority";
import type { InspectionPlanQueryIssue } from "#typepeek/inspection/inspection-plan-query";
import { readInspectionPlanQueries } from "#typepeek/inspection/inspection-plan-query";
import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { InvalidInvocationError } from "#typepeek/invalid-invocation-error";
import { decodeJson } from "#typepeek/json-data";
import { renderJsonOutcome } from "#typepeek/json-rendering";
import {
  serializeTerminalSafeJson,
  terminalSafeLine,
} from "#typepeek/output-safety";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";
import { runProtocolWireStream } from "#typepeek/protocol-wire";
import type { TerminalRenderingOptions } from "#typepeek/terminal-rendering";
import { renderInspection } from "#typepeek/terminal-rendering";

import { selectCliWorkspace } from "./cli-workspace.ts";

interface CliExitState {
  value: number | string | null;
}

const ACCESS_STYLE_CHOICES = "import|require";
const SIGNATURE_INSPECTION = "signature-inspection";

const MAX_CLI_DIAGNOSTIC_BYTES = 128 * 1024;
const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;
const MAX_PLAN_QUERY_JSON_BYTES = 16 * 1024;

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
  "discover",
  "subpaths",
  "declarations",
  "member",
  "members",
  "compare",
]);

const INVALID_INVOCATION_EXIT_CODES = new Set([-5, -4]);

interface CliDiagnostic {
  readonly status: "internal-error" | "invalid-invocation";
  readonly message: string;
}

type CliExitCode = number | string | undefined;

interface CliDiagnosticSnapshot {
  readonly exitCode: CliExitCode;
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
  readonly cursor?: string;
  readonly match?: string;
  readonly subpaths: boolean;
}

interface MemberDiscoveryOptions extends InspectionTargetOptions {
  readonly match?: string;
}

const readableEnvironment = function readableEnvironment(): Readonly<
  Record<string, string>
> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
};

const normalizeNonNumberExitCode = function normalizeNonNumberExitCode(
  exitCode: string | null
): string | undefined {
  return exitCode ?? undefined;
};

const normalizedNegativeExitCode = function normalizedNegativeExitCode(
  exitCode: number
): number {
  return INVALID_INVOCATION_EXIT_CODES.has(exitCode)
    ? INVALID_INVOCATION_EXIT_CODE
    : INTERNAL_ERROR_EXIT_CODE;
};

const normalizeExitCode = function normalizeExitCode(
  exitCode: number | string | null
): number | string | undefined {
  if (!Predicate.isNumber(exitCode)) {
    return normalizeNonNumberExitCode(exitCode);
  }

  if (exitCode >= 0) {
    return exitCode;
  }

  return normalizedNegativeExitCode(exitCode);
};

const requestsFlag = function requestsFlag(
  inputs: readonly string[],
  flag: "--json" | "--pretty"
): boolean {
  for (const input of inputs) {
    if (input === "--") {
      return false;
    }

    if (input === flag) {
      return true;
    }
  }

  return false;
};

const requestsJson = function requestsJson(inputs: readonly string[]): boolean {
  return requestsFlag(inputs, "--json");
};

const cliDiagnosticLimitMessage = function cliDiagnosticLimitMessage(): string {
  return "CLI diagnostic exceeded its output limit.";
};

const cliDiagnosticStatus = function cliDiagnosticStatus(
  exitCode: number | string | undefined
): CliDiagnostic["status"] {
  return exitCode === INVALID_INVOCATION_EXIT_CODE
    ? "invalid-invocation"
    : "internal-error";
};

const renderCliDiagnostic = function renderCliDiagnostic(
  snapshot: CliDiagnosticSnapshot,
  pretty: boolean
): string {
  const diagnostic: CliDiagnostic = {
    message: snapshot.exceeded
      ? cliDiagnosticLimitMessage()
      : snapshot.stderr.trimEnd(),
    status: cliDiagnosticStatus(snapshot.exitCode),
  };

  const rendered = serializeTerminalSafeJson(diagnostic, pretty);

  return Buffer.byteLength(rendered) <= MAX_CLI_DIAGNOSTIC_BYTES
    ? rendered
    : serializeTerminalSafeJson(
        {
          message: cliDiagnosticLimitMessage(),
          status: diagnostic.status,
        } satisfies CliDiagnostic,
        pretty
      );
};

const requestsPretty = function requestsPretty(
  inputs: readonly string[]
): boolean {
  return requestsFlag(inputs, "--pretty");
};

const renderHumanCliDiagnostic = function renderHumanCliDiagnostic(
  snapshot: CliDiagnosticSnapshot
): string {
  if (!snapshot.exceeded) {
    const rendered = `${terminalSafeLine(snapshot.stderr.trimEnd())}\n`;

    if (Buffer.byteLength(rendered) <= MAX_CLI_DIAGNOSTIC_BYTES) {
      return rendered;
    }
  }

  return `${cliDiagnosticStatus(snapshot.exitCode)}: ${cliDiagnosticLimitMessage()}\n`;
};

const writeCapturedDiagnostic = function writeCapturedDiagnostic(
  rawInputs: readonly string[],
  diagnostic: CliDiagnosticSnapshot
): void {
  if (requestsJson(rawInputs)) {
    process.stdout.write(
      `${renderCliDiagnostic(diagnostic, requestsPretty(rawInputs))}\n`
    );

    return;
  }

  process.stderr.write(renderHumanCliDiagnostic(diagnostic));
};

class CliProcessSession {
  #capturedStderr = "";
  #capturedStderrBytes = 0;
  readonly #exitState: CliExitState = { value: null };
  readonly process: StricliProcess;
  constructor() {
    const exitState = this.#exitState;
    this.process = {
      env: readableEnvironment(),
      get exitCode() {
        return exitState.value;
      },
      set exitCode(value) {
        exitState.value = value;
      },
      stderr: {
        getColorDepth: () => 0,
        write: (value) => {
          this.#captureStderr(value);
        },
      },
      stdout: process.stdout,
    };
  }
  complete(rawInputs: readonly string[]): void {
    const normalizedExitCode = normalizeExitCode(this.#exitState.value);

    if (this.#capturedStderr !== "" || this.#captureExceeded) {
      writeCapturedDiagnostic(rawInputs, {
        exceeded: this.#captureExceeded,
        exitCode: normalizedExitCode,
        stderr: this.#capturedStderr,
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

const parseAccessStyle = function parseAccessStyle(
  input: string
): "import" | "require" {
  if (input === "import" || input === "require") {
    return input;
  }

  throw new Error('Access Style must be "import" or "require".');
};

const inspectionTargetFlags = {
  access: {
    brief: "Resolve declarations using import or require conditions.",
    default: "import",
    kind: "parsed",
    parse: parseAccessStyle,
    placeholder: ACCESS_STYLE_CHOICES,
  },
  json: {
    brief: "Emit structured JSON for agents and pipelines.",
    default: false,
    kind: "boolean",
    withNegated: false,
  },
  pretty: {
    brief: "Indent JSON output; requires --json.",
    default: false,
    kind: "boolean",
    withNegated: false,
  },
  workspace: {
    brief: "Resolve the package from this consuming workspace.",
    kind: "parsed",
    optional: true,
    parse: (input: string) => nodePath.resolve(input),
    placeholder: "path",
  },
} as const;

const specifierParameter = {
  brief:
    "Package root, Public Subpath, or Node Platform Module Specifier to inspect.",
  parse: (input: string) => input,
  placeholder: "specifier",
} as const;

const beforeSpecifierParameter = {
  ...specifierParameter,
  brief:
    "Package root, Public Subpath, or Node Platform Module Specifier for the before side.",
  placeholder: "before-specifier",
} as const;

const afterSpecifierParameter = {
  ...specifierParameter,
  brief:
    "Package root, Public Subpath, or Node Platform Module Specifier for the after side.",
  placeholder: "after-specifier",
} as const;

const exportNameParameter = {
  brief: "Exact Module Export name to inspect.",
  parse: (input: string) => input,
  placeholder: "export-name",
} as const;

const exportSearchQueryParameter = {
  brief: "Case-insensitive substring to match against Module Export names.",
  parse: (input: string) => input,
  placeholder: "query",
} as const;

const parseMemberPathJson = function parseMemberPathJson(
  input: string
): Schema.Json {
  try {
    return decodeJson(Schema.Json, input);
  } catch {
    throw new Error(
      "Member path must be a valid JSON array of names or {name, space} selectors."
    );
  }
};

const parseMemberPath = function parseMemberPath(
  input: string,
  allowEmpty = false
): MemberPath {
  const memberPath = readBoundedMemberPath(
    input.startsWith("[") ? parseMemberPathJson(input) : [input],
    allowEmpty
  );

  if (memberPath === undefined) {
    throw new Error(
      `Member path must contain from ${allowEmpty ? 0 : 1} through 16 non-empty names (at most 256 bytes each), optionally qualified with type, value, or namespace.`
    );
  }

  return memberPath;
};

const memberPathParameter = {
  brief:
    "One exact Member name or a JSON array of names and {name, space} selectors.",
  parse: parseMemberPath,
  placeholder: "member-path",
} as const;

const parseInspectionPlanJson = function parseInspectionPlanJson(
  input: string
): Schema.Json {
  try {
    return decodeJson(Schema.Json, input);
  } catch {
    throw new Error("Inspection Plan queries must be valid JSON.");
  }
};

const inspectionPlanQueryIssueMessage =
  function inspectionPlanQueryIssueMessage(
    issue: InspectionPlanQueryIssue
  ): string {
    const messages = {
      "invalid-entry": "Each Inspection Plan query must be an object.",
      "invalid-focused":
        "Each focused Inspection Plan query requires a string exportName.",
      "invalid-list":
        "Inspection Plan queries must contain from 1 through 16 entries.",
      "invalid-member":
        "Each Member Inspection query requires an exportName and memberPath.",
      "invalid-member-discovery":
        "Each Member Discovery query requires an exportName; optional memberPath and query must be bounded.",
      "invalid-search":
        "Each Export Search query requires a bounded non-empty query string.",
      "unsupported-intent":
        "Each Inspection Plan query has an unsupported intent.",
    } as const satisfies Readonly<Record<InspectionPlanQueryIssue, string>>;

    return messages[issue];
  };

const parseInspectionPlanQueries = function parseInspectionPlanQueries(
  input: string
): readonly InspectionPlanQuery[] {
  if (Buffer.byteLength(input) > MAX_PLAN_QUERY_JSON_BYTES) {
    throw new Error("Inspection Plan query JSON exceeds its input limit.");
  }

  const reading = readInspectionPlanQueries(parseInspectionPlanJson(input));

  if (!reading.accepted) {
    throw new Error(inspectionPlanQueryIssueMessage(reading.issue));
  }

  return reading.queries;
};

const inspectionPlanQueriesParameter = {
  brief: "JSON array of inspection queries to run together.",
  parse: parseInspectionPlanQueries,
  placeholder: "queries-json",
} as const;

const overviewJsonOptionError = function overviewJsonOptionError(
  options: OverviewOptions
): Error | undefined {
  if (!options.json) {
    return undefined;
  }

  if (options.subpaths) {
    return new InvalidInvocationError(
      "--subpaths cannot be combined with --json."
    );
  }

  return options.match === undefined
    ? undefined
    : new InvalidInvocationError("--match cannot be combined with --json.");
};

const resolutionContextForSpecifier = function resolutionContextForSpecifier(
  specifier: string,
  explicitWorkspace: string | undefined,
  workspaceFlag: "--workspace" | "--before-workspace" | "--after-workspace"
): string | InvalidInvocationError {
  const selection = selectCliWorkspace(
    specifier,
    explicitWorkspace,
    workspaceFlag
  );

  return selection instanceof Error
    ? new InvalidInvocationError(selection.message)
    : selection;
};

const inspectionRequest = function inspectionRequest(
  options: InspectionTargetOptions,
  specifier: string
) {
  const resolutionContext = resolutionContextForSpecifier(
    specifier,
    options.workspace,
    "--workspace"
  );

  if (resolutionContext instanceof Error) {
    return resolutionContext;
  }

  return {
    accessStyle: options.access,
    resolutionContext,
    specifier,
  } as const;
};

const cliRequestUsesSignatureEvidence =
  function cliRequestUsesSignatureEvidence<Intent extends InspectionIntent>(
    intent: Intent,
    request: InspectionRequestByIntent[Intent]
  ): boolean {
    if (intent === SIGNATURE_INSPECTION) {
      return true;
    }

    if (intent !== "inspection-plan") {
      return false;
    }

    return (
      "queries" in request &&
      request.queries.some((query) => query.intent === SIGNATURE_INSPECTION)
    );
  };

const invokeCliInspection = async function invokeCliInspection<
  Intent extends InspectionIntent,
>(
  intent: Intent,
  request: InspectionRequestByIntent[Intent]
): Promise<InspectionOutcome> {
  const response = await invokeInspectionProtocol({
    intent,
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    request,
    ...(cliRequestUsesSignatureEvidence(intent, request) && {
      response: { signatureEvidence: "both" },
    }),
  });

  return enforceInspectionOutcome(intent, response.outcome);
};

const writeJsonOutcome = function writeJsonOutcome(
  context: ApplicationContext,
  outcome: InspectionOutcome,
  pretty: boolean
): void {
  const rendering = renderJsonOutcome(outcome, pretty);
  context.process.stdout.write(`${rendering.text}\n`);

  if (rendering.failed) {
    context.process.exitCode = INSPECTION_FAILURE_EXIT_CODE;
  }
};

const renderForCommand = function renderForCommand(
  result: InspectionResult,
  options: TerminalRenderingOptions
): string | Error {
  try {
    return renderInspection(result, options);
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      return new InspectionFailureError(`limit-exceeded: ${error.message}`);
    }

    throw error;
  }
};

const writeCliOutcome = function writeCliOutcome(
  context: ApplicationContext,
  options: CliOutputOptions,
  outcome: InspectionOutcome,
  renderingOptions: TerminalRenderingOptions = {}
): Error | undefined {
  if (options.json) {
    writeJsonOutcome(context, outcome, options.pretty);

    return undefined;
  }

  if (outcome.status !== "success") {
    return new InspectionFailureError(
      terminalSafeLine(`${outcome.status}: ${outcome.message}`)
    );
  }

  const rendering = renderForCommand(outcome.result, renderingOptions);

  if (rendering instanceof Error) {
    return rendering;
  }

  context.process.stdout.write(`${rendering}\n`);

  return undefined;
};

const runCliTargetInspection = async function runCliTargetInspection<
  Intent extends InspectionIntent,
>(
  context: ApplicationContext,
  intent: Intent,
  options: InspectionTargetOptions,
  specifier: string,
  requestForTarget: (
    target: CliInspectionTargetRequest
  ) => InspectionRequestByIntent[Intent],
  renderingOptions: TerminalRenderingOptions = {}
): Promise<Error | undefined> {
  const target = inspectionRequest(options, specifier);

  if (target instanceof Error) {
    return target;
  }

  const outcome = await invokeCliInspection(intent, requestForTarget(target));

  return writeCliOutcome(context, options, outcome, renderingOptions);
};

const overviewCommand = buildCommand<
  OverviewOptions,
  [string],
  ApplicationContext
>({
  docs: {
    brief: "List the module exports and public subpaths.",
    fullDescription:
      "Example: typepeek overview zod. Use --json for one structured Inspection Outcome.",
  },
  async func(options, specifier) {
    const optionError = overviewJsonOptionError(options);

    if (optionError !== undefined) {
      return optionError;
    }

    return await runCliTargetInspection(
      this,
      "interface-overview",
      options,
      specifier,
      (target) => ({
        ...target,
        ...(options.cursor !== undefined && { cursor: options.cursor }),
      }),
      {
        includePublicSubpaths: options.subpaths,
        ...(options.match !== undefined && {
          moduleExportMatch: options.match,
        }),
      }
    );
  },
  parameters: {
    flags: {
      ...inspectionTargetFlags,
      cursor: {
        brief:
          'Return 100 export names; use "start" for the first page, then the returned cursor.',
        kind: "parsed",
        optional: true,
        parse: (input: string) => input,
        placeholder: "cursor",
      },
      match: {
        brief: "Match Module Export names case-insensitively in human output.",
        kind: "parsed",
        optional: true,
        parse: (input: string) => input,
        placeholder: "substring",
      },
      subpaths: {
        brief: "List every Public Subpath in the human Interface Overview.",
        default: false,
        kind: "boolean",
        withNegated: false,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [specifierParameter],
    },
  },
});

const exportCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  docs: {
    brief:
      "Show an export's declarations, signatures, documentation, and supporting types.",
    fullDescription:
      "Example: typepeek export zod ZodError. Use it when you need declarations or Supporting Types.",
  },
  async func(options, specifier, exportName) {
    return await runCliTargetInspection(
      this,
      "export-inspection",
      options,
      specifier,
      (target) => ({
        ...target,
        exportName,
      })
    );
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportNameParameter],
    },
  },
});

const signaturesCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  docs: {
    brief: "Show every public call and construct signature of an export.",
    fullDescription:
      "Example: typepeek signatures execa execa --json emits structured type parameters, parameters, and return semantics.",
  },
  async func(options, specifier, exportName) {
    return await runCliTargetInspection(
      this,
      SIGNATURE_INSPECTION,
      options,
      specifier,
      (target) => ({
        ...target,
        exportName,
      })
    );
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportNameParameter],
    },
  },
});

const declarationsCommand = buildCommand<
  InspectionTargetOptions,
  [string, string],
  ApplicationContext
>({
  docs: {
    brief: "Show an export's declarations.",
    fullDescription:
      "Example: typepeek declarations zod ZodError avoids Signature and Supporting Type traversal.",
  },
  async func(options, specifier, exportName) {
    return await runCliTargetInspection(
      this,
      "declaration-inspection",
      options,
      specifier,
      (target) => ({
        ...target,
        exportName,
      })
    );
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, exportNameParameter],
    },
  },
});

const memberCommand = buildCommand<
  InspectionTargetOptions,
  [string, string, MemberPath],
  ApplicationContext
>({
  docs: {
    brief: "Show the declarations for one public member path.",
    fullDescription:
      "Example: typepeek member zod ZodError issues avoids unrelated declaration traversal.",
  },
  async func(options, specifier, exportName, memberPath) {
    return await runCliTargetInspection(
      this,
      "member-inspection",
      options,
      specifier,
      (target) => ({
        ...target,
        exportName,
        memberPath,
      })
    );
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [
        specifierParameter,
        exportNameParameter,
        memberPathParameter,
      ],
    },
  },
});

const membersCommand = buildCommand<
  MemberDiscoveryOptions,
  [string, string, MemberPath?],
  ApplicationContext
>({
  docs: {
    brief: "List immediate public members and their declaration spaces.",
    fullDescription:
      'Example: typepeek members zod ZodError --match issue lists matching names. Omit member-path to inspect the export; pass a JSON path such as \'[{"name":"shared","space":"type"}]\' to select a declaration space at a nested step. Discovery returns a complete count before filtering.',
  },
  async func(options, specifier, exportName, memberPath) {
    return await runCliTargetInspection(
      this,
      "member-discovery",
      options,
      specifier,
      (target) => ({
        ...target,
        exportName,
        ...(memberPath !== undefined && { memberPath }),
        ...(options.match !== undefined && { query: options.match }),
      })
    );
  },
  parameters: {
    flags: {
      ...inspectionTargetFlags,
      match: {
        brief:
          "Filter public Member names case-insensitively in every output format.",
        kind: "parsed",
        optional: true,
        parse: (input: string) => input,
        placeholder: "substring",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        specifierParameter,
        exportNameParameter,
        {
          ...memberPathParameter,
          optional: true,
          parse: (input: string) => parseMemberPath(input, true),
        },
      ],
    },
  },
});

const planCommand = buildCommand<
  InspectionTargetOptions,
  [string, readonly InspectionPlanQuery[]],
  ApplicationContext
>({
  docs: {
    brief: "Run several queries against the same installed evidence.",
    fullDescription:
      'Example: typepeek plan zod \'[{"intent":"interface-overview"}]\' --json returns one atomic outcome.',
  },
  async func(options, specifier, queries) {
    return await runCliTargetInspection(
      this,
      "inspection-plan",
      options,
      specifier,
      (target) => ({
        ...target,
        queries,
      })
    );
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter, inspectionPlanQueriesParameter],
    },
  },
});

const buildExportSearchCommand = function buildExportSearchCommand(
  scope?: "documentation"
) {
  return buildCommand<
    InspectionTargetOptions,
    [string, string],
    ApplicationContext
  >({
    docs: {
      brief:
        scope === undefined
          ? "Find export names containing a case-insensitive substring."
          : "Discover exports by names and attached documentation, with signatures.",
      fullDescription:
        scope === undefined
          ? "Search export names by case-insensitive substring. Use discover when you know a behavior rather than a name."
          : "Match a case-insensitive substring in export names and attached JSDoc, not documentation files or semantic similarity. Results include complete signatures and marked, untrusted documentation excerpts.",
    },
    async func(options, specifier, query) {
      return await runCliTargetInspection(
        this,
        "export-search",
        options,
        specifier,
        (target) => ({
          ...target,
          query,
          ...(scope !== undefined && { scope }),
        })
      );
    },
    parameters: {
      flags: inspectionTargetFlags,
      positional: {
        kind: "tuple",
        parameters: [specifierParameter, exportSearchQueryParameter],
      },
    },
  });
};

const searchCommand = buildExportSearchCommand();
const discoverCommand = buildExportSearchCommand("documentation");

const subpathsCommand = buildCommand<
  InspectionTargetOptions,
  [string],
  ApplicationContext
>({
  docs: {
    brief: "List public subpaths exposed by the package manifest.",
    fullDescription:
      "Example: typepeek subpaths zod lists only bounded manifest Public Subpaths.",
  },
  async func(options, specifier) {
    return await runCliTargetInspection(
      this,
      "public-subpath-discovery",
      options,
      specifier,
      (target) => target
    );
  },
  parameters: {
    flags: inspectionTargetFlags,
    positional: {
      kind: "tuple",
      parameters: [specifierParameter],
    },
  },
});

const capabilitiesCommand = buildCommand<
  CliOutputOptions,
  [],
  ApplicationContext
>({
  docs: {
    brief: "List supported protocol requests and limits as JSON.",
    fullDescription:
      "Capability output is always JSON. Pass --json to select machine-mode diagnostics; add --pretty for indented output.",
  },
  func(options) {
    this.process.stdout.write(
      `${serializeTerminalSafeJson(inspectCapabilities(), options.pretty)}\n`
    );
  },
  parameters: {
    flags: {
      json: inspectionTargetFlags.json,
      pretty: inspectionTargetFlags.pretty,
    },
    positional: {
      kind: "tuple",
      parameters: [],
    },
  },
});

const protocolCommand = buildCommand<
  Readonly<Record<string, never>>,
  [],
  ApplicationContext
>({
  docs: {
    brief: "Invoke the Inspection Protocol with JSON request lines on stdin.",
    fullDescription:
      "Read compact JSON request lines from stdin and emit one compact JSON response line per request on stdout, in order, until stdin closes. Empty input closes without a response. Each line may contain at most 32 KiB of UTF-8 JSON; the final newline is optional. Invalid wire input ends the stream. Inspection failures allow further requests and leave exit status 1. Run typepeek capabilities --json first to discover valid requests, response options, and recovery limits.",
  },
  async func() {
    const exitCode = await runProtocolWireStream(process.stdin, process.stdout);
    this.process.exitCode = Math.max(
      Number(this.process.exitCode ?? 0),
      exitCode
    );
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [],
    },
  },
});

const compareCommand = buildCommand<
  ComparisonOptions,
  [string, string],
  ApplicationContext
>({
  docs: {
    brief: "Compare export names and public subpaths in two complete indexes.",
    fullDescription:
      "Example: typepeek compare zod zod --before-workspace old --after-workspace new compares installed versions directionally.",
  },
  async func(options, beforeSpecifier, afterSpecifier) {
    const beforeResolutionContext = resolutionContextForSpecifier(
      beforeSpecifier,
      options.beforeWorkspace,
      "--before-workspace"
    );

    if (beforeResolutionContext instanceof Error) {
      return beforeResolutionContext;
    }

    const afterResolutionContext = resolutionContextForSpecifier(
      afterSpecifier,
      options.afterWorkspace,
      "--after-workspace"
    );

    if (afterResolutionContext instanceof Error) {
      return afterResolutionContext;
    }

    const outcome = await invokeCliInspection("public-interface-comparison", {
      after: {
        accessStyle: options.afterAccess,
        resolutionContext: afterResolutionContext,
        specifier: afterSpecifier,
      },
      before: {
        accessStyle: options.beforeAccess,
        resolutionContext: beforeResolutionContext,
        specifier: beforeSpecifier,
      },
    });

    return writeCliOutcome(this, options, outcome);
  },
  parameters: {
    flags: {
      afterAccess: {
        brief: "Access Style for the after Resolution Variant.",
        default: "import",
        kind: "parsed",
        parse: parseAccessStyle,
        placeholder: ACCESS_STYLE_CHOICES,
      },
      afterWorkspace: {
        brief: "Consuming workspace for the after Interface Overview.",
        kind: "parsed",
        optional: true,
        parse: (input: string) => nodePath.resolve(input),
        placeholder: "path",
      },
      beforeAccess: {
        brief: "Access Style for the before Resolution Variant.",
        default: "import",
        kind: "parsed",
        parse: parseAccessStyle,
        placeholder: ACCESS_STYLE_CHOICES,
      },
      beforeWorkspace: {
        brief: "Consuming workspace for the before Interface Overview.",
        kind: "parsed",
        optional: true,
        parse: (input: string) => nodePath.resolve(input),
        placeholder: "path",
      },
      json: inspectionTargetFlags.json,
      pretty: inspectionTargetFlags.pretty,
    },
    positional: {
      kind: "tuple",
      parameters: [beforeSpecifierParameter, afterSpecifierParameter],
    },
  },
});

const rootRoute = buildRouteMap({
  defaultCommand: "overview",
  docs: {
    brief:
      "Inspect TypeScript interfaces from installed packages and Node platform modules.",
    fullDescription:
      "Use overview or search to find exports, discover to match names and attached documentation with signatures, subpaths to find public entrypoints, and members to find public members. Inspect signatures, declarations, or a member for details; use export to include documentation and supporting types. Run known queries together with plan, or compare export names and subpaths with compare. For machine integration, run capabilities before sending requests to protocol. Common flags may precede or follow an explicit inspection command.",
  },
  routes: {
    capabilities: capabilitiesCommand,
    compare: compareCommand,
    declarations: declarationsCommand,
    discover: discoverCommand,
    export: exportCommand,
    member: memberCommand,
    members: membersCommand,
    overview: overviewCommand,
    plan: planCommand,
    protocol: protocolCommand,
    search: searchCommand,
    signatures: signaturesCommand,
    subpaths: subpathsCommand,
  },
});

const app = buildApplication(
  rootRoute,
  {
    determineExitCode(error) {
      if (error instanceof InvalidInvocationError) {
        return INVALID_INVOCATION_EXIT_CODE;
      }

      return error instanceof InspectionFailureError
        ? INSPECTION_FAILURE_EXIT_CODE
        : INTERNAL_ERROR_EXIT_CODE;
    },
    name: "typepeek",
    scanner: {
      allowArgumentEscapeSequence: true,
      caseStyle: "allow-kebab-for-camel",
    },
  },
  {
    help: help({
      alias: "h",
      brief: "Print help information and exit",
      defaultForRouteMap: true,
      formatting: {
        caseStyle: "convert-camel-to-kebab",
        onlyRequiredInUsageLine: false,
        useAliasInUsageLine: false,
      },
      includeHidden: false,
    }),
    helpAll: help({
      alias: "H",
      brief:
        "Print help information (including hidden commands/flags) and exit",
      formatting: {
        caseStyle: "convert-camel-to-kebab",
        onlyRequiredInUsageLine: false,
        useAliasInUsageLine: false,
      },
      hidden: true,
      includeHidden: true,
    }),
    version: version({
      brief: "Print version information and exit",
      info: { currentVersion: TYPEPEEK_VERSION },
    }),
  }
);

const leadingCommonOptionsEnd = function leadingCommonOptionsEnd(
  inputs: readonly string[]
): number {
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
};

const normalizeCommonOptionPlacement = function normalizeCommonOptionPlacement(
  inputs: readonly string[]
): readonly string[] {
  const commandIndex = leadingCommonOptionsEnd(inputs);
  const command = inputs[commandIndex];

  return commandIndex > 0 &&
    command !== undefined &&
    INSPECTION_COMMANDS.has(command)
    ? [
        command,
        ...inputs.slice(0, commandIndex),
        ...inputs.slice(commandIndex + 1),
      ]
    : inputs;
};

export const runCli = async function runCli(
  rawInputs: readonly string[]
): Promise<void> {
  const session = new CliProcessSession();

  if (requestsPretty(rawInputs) && !requestsJson(rawInputs)) {
    session.process.stderr.write("--pretty requires --json.\n");
    session.process.exitCode = INVALID_INVOCATION_EXIT_CODE;
    session.complete(rawInputs);

    return;
  }

  const inputs =
    rawInputs.length === 0
      ? ["--help"]
      : normalizeCommonOptionPlacement(rawInputs);

  await run(app, inputs, { process: session.process });
  session.complete(rawInputs);
};
