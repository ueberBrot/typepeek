import nodePath from "node:path";

import { Effect, Exit, Option, Schema, Scope } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { InspectionFailureError } from "#typepeek/cli/inspection-failure-error";
import { InvalidInvocationError } from "#typepeek/cli/invalid-invocation-error";
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
} from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import { enforceInspectionOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";
import { invokeInspectionProtocolEffect } from "#typepeek/inspection/model/inspection-protocol";
import { readBoundedMemberPath } from "#typepeek/inspection/model/member-path";
import type { InspectionOutcome } from "#typepeek/inspection/model/protocol";
import type { InspectionPlanQueryIssue } from "#typepeek/inspection/queries/inspection-plan-query";
import { readInspectionPlanQueries } from "#typepeek/inspection/queries/inspection-plan-query";
import { renderJsonOutcome } from "#typepeek/presentation/json-rendering";
import {
  serializeTerminalSafeJson,
  terminalSafeLine,
} from "#typepeek/presentation/output-safety";
import type { TerminalRenderingOptions } from "#typepeek/presentation/terminal-rendering";
import { renderInspection } from "#typepeek/presentation/terminal-rendering";
import { runProtocolWireStream } from "#typepeek/protocol/protocol-wire";
import { decodeJson } from "#typepeek/shared/json-data";

import {
  createCliRunner,
  INSPECTION_FAILURE_EXIT_CODE,
} from "./cli-execution.ts";
import { selectCliWorkspace } from "./cli-workspace.ts";

const taggedError = Schema.TaggedError;

class ProtocolExchangeError extends taggedError<
  ProtocolExchangeError,
  { readonly brand: unique symbol }
>()("ProtocolExchangeError", { message: Schema.String }) {}

const SIGNATURE_INSPECTION = "signature-inspection";

const MAX_PLAN_QUERY_JSON_BYTES = 16 * 1024;

interface CliOutputOptions {
  readonly json: boolean;
  readonly pretty: boolean;
}

interface InspectionTargetOptions extends CliOutputOptions {
  readonly access: "import" | "require";
  readonly workspace: string | undefined;
}

interface CliInspectionTargetRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle: "import" | "require";
}

interface OverviewOptions extends InspectionTargetOptions {
  readonly cursor: string | undefined;
  readonly match: string | undefined;
  readonly subpaths: boolean;
}

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

const invokeCliInspection = Effect.fnUntraced(function* invokeCliInspection<
  Intent extends InspectionIntent,
>(intent: Intent, request: InspectionRequestByIntent[Intent]) {
  const response = yield* invokeInspectionProtocolEffect({
    intent,
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    request,
    ...(cliRequestUsesSignatureEvidence(intent, request) && {
      response: { signatureEvidence: "both" },
    }),
  });

  return enforceInspectionOutcome(intent, response.outcome);
});

const writeJsonOutcome = function writeJsonOutcome(
  outcome: InspectionOutcome,
  pretty: boolean
): void {
  const rendering = renderJsonOutcome(outcome, pretty);
  process.stdout.write(`${rendering.text}\n`);

  if (rendering.failed) {
    process.exitCode = INSPECTION_FAILURE_EXIT_CODE;
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
  options: CliOutputOptions,
  outcome: InspectionOutcome,
  renderingOptions: TerminalRenderingOptions = {}
): Error | undefined {
  if (options.json) {
    writeJsonOutcome(outcome, options.pretty);

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

  process.stdout.write(`${rendering}\n`);

  return undefined;
};

const runCliTargetInspection = Effect.fnUntraced(
  function* runCliTargetInspection<Intent extends InspectionIntent>(
    intent: Intent,
    options: InspectionTargetOptions,
    specifier: string,
    requestForTarget: (
      target: CliInspectionTargetRequest
    ) => InspectionRequestByIntent[Intent],
    renderingOptions: TerminalRenderingOptions = {}
  ) {
    const target = inspectionRequest(options, specifier);

    if (target instanceof Error) {
      return yield* Effect.fail(target);
    }

    const outcome = yield* invokeCliInspection(
      intent,
      requestForTarget(target)
    );

    const error = writeCliOutcome(options, outcome, renderingOptions);

    if (error !== undefined) {
      return yield* Effect.fail(error);
    }

    return yield* Effect.void;
  }
);

const optionalFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withMetavar(name),
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

const workspaceFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withMetavar("path"),
    Flag.map((input) => nodePath.resolve(input)),
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

const outputFlags = {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit structured JSON for agents and pipelines."),
    Flag.withoutNegation,
    Flag.withDefault(false)
  ),
  pretty: Flag.Boolean("pretty").pipe(
    Flag.withDescription("Indent JSON output; requires --json."),
    Flag.withoutNegation,
    Flag.withDefault(false)
  ),
};

const targetFlags = {
  ...outputFlags,
  access: Flag.Literals("access", ["import", "require"]).pipe(
    Flag.withDefault("import"),
    Flag.withMetavar("import|require"),
    Flag.withDescription(
      "Resolve declarations using import or require conditions."
    )
  ),
  workspace: workspaceFlag(
    "workspace",
    "Resolve the package from this consuming workspace."
  ),
};

const specifier = Argument.String("specifier").pipe(
  Argument.withDescription(
    "Package root, Public Subpath, or Node Platform Module Specifier to inspect."
  )
);

const exportName = Argument.String("export-name").pipe(
  Argument.withDescription("Exact Module Export name to inspect.")
);

const parseMessage: Parameters<typeof Argument.mapTryCatch>[2] = (error) =>
  error instanceof Error ? error.message : String(error);

const memberPath = Argument.String("member-path").pipe(
  Argument.mapTryCatch(parseMemberPath, parseMessage)
);

const overviewCommand = Command.make(
  "overview",
  {
    ...targetFlags,
    cursor: optionalFlag(
      "cursor",
      'Return 100 export names; use "start" for the first page, then the returned cursor.'
    ),
    match: optionalFlag(
      "match",
      "Match Module Export names case-insensitively in human output."
    ),
    specifier,
    subpaths: Flag.Boolean("subpaths").pipe(
      Flag.withoutNegation,
      Flag.withDefault(false),
      Flag.withDescription(
        "List every Public Subpath in the human Interface Overview."
      )
    ),
  },
  Effect.fnUntraced(function* overviewCommand(options) {
    const error = overviewJsonOptionError(options);

    if (error !== undefined) {
      return yield* Effect.fail(error);
    }

    return yield* runCliTargetInspection(
      "interface-overview",
      options,
      options.specifier,
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
  })
).pipe(
  Command.withDescription(
    "List the module exports and public subpaths. Example: typepeek overview zod. Use --json for one structured Inspection Outcome."
  )
);

const optionalMemberPath = Argument.String("member-path").pipe(
  Argument.mapTryCatch((input) => parseMemberPath(input, true), parseMessage),
  Argument.optional,
  Argument.map(Option.getOrUndefined)
);

const planQueries = Argument.String("queries").pipe(
  Argument.withDescription("JSON array of inspection queries to run together."),
  Argument.mapTryCatch(parseInspectionPlanQueries, parseMessage)
);

const exportCommand = Command.make(
  "export",
  { ...targetFlags, args: [specifier, exportName] },
  (options) =>
    runCliTargetInspection(
      "export-inspection",
      options,
      options.args[0],
      (target) => ({ ...target, exportName: options.args[1] })
    )
).pipe(
  Command.withDescription(
    "Show an export's declarations, signatures, documentation, and supporting types. Example: typepeek export zod ZodError."
  )
);

const signaturesCommand = Command.make(
  "signatures",
  { ...targetFlags, args: [specifier, exportName] },
  (options) =>
    runCliTargetInspection(
      SIGNATURE_INSPECTION,
      options,
      options.args[0],
      (target) => ({ ...target, exportName: options.args[1] })
    )
).pipe(
  Command.withDescription(
    "Show every public call and construct signature of an export. Example: typepeek signatures semver parse --json emits structured type parameters, parameters, and return semantics."
  )
);

const declarationsCommand = Command.make(
  "declarations",
  { ...targetFlags, args: [specifier, exportName] },
  (options) =>
    runCliTargetInspection(
      "declaration-inspection",
      options,
      options.args[0],
      (target) => ({ ...target, exportName: options.args[1] })
    )
).pipe(
  Command.withDescription(
    "Show an export's declarations. Example: typepeek declarations zod ZodError avoids Signature and Supporting Type traversal."
  )
);

const memberCommand = Command.make(
  "member",
  { ...targetFlags, args: [specifier, exportName, memberPath] },
  (options) =>
    runCliTargetInspection(
      "member-inspection",
      options,
      options.args[0],
      (target) => ({
        ...target,
        exportName: options.args[1],
        memberPath: options.args[2],
      })
    )
).pipe(
  Command.withDescription(
    "Show the declarations for one public member path. Example: typepeek member zod ZodError issues avoids unrelated declaration traversal."
  )
);

const membersCommand = Command.make(
  "members",
  {
    ...targetFlags,
    args: [specifier, exportName, optionalMemberPath],
    match: optionalFlag(
      "match",
      "Filter public Member names case-insensitively in every output format."
    ),
  },
  (options) =>
    runCliTargetInspection(
      "member-discovery",
      options,
      options.args[0],
      (target) => ({
        ...target,
        exportName: options.args[1],
        ...(options.args[2] !== undefined && {
          memberPath: options.args[2],
        }),
        ...(options.match !== undefined && { query: options.match }),
      })
    )
).pipe(
  Command.withDescription(
    "List immediate public members and their declaration spaces. Omit member-path to inspect the export; pass a JSON path to select a declaration space. Discovery returns a complete count before filtering."
  )
);

const planCommand = Command.make(
  "plan",
  {
    ...targetFlags,
    args: [specifier, planQueries],
  },
  (options) =>
    runCliTargetInspection(
      "inspection-plan",
      options,
      options.args[0],
      (target) => ({ ...target, queries: options.args[1] })
    )
).pipe(
  Command.withDescription(
    "Run several queries against the same installed evidence. Return one atomic outcome."
  )
);

const exportSearchCommand = (name: "search" | "discover") =>
  Command.make(
    name,
    {
      ...targetFlags,
      args: [specifier, Argument.String("query")],
    },
    (options) =>
      runCliTargetInspection(
        "export-search",
        options,
        options.args[0],
        (target) => ({
          ...target,
          query: options.args[1],
          ...(name === "discover" && { scope: "documentation" as const }),
        })
      )
  ).pipe(
    Command.withDescription(
      name === "search"
        ? "Find export names containing a case-insensitive substring. Use discover when you know a behavior rather than a name."
        : "Discover exports by names and attached documentation, with signatures. Match a case-insensitive substring in export names and attached JSDoc, not documentation files or semantic similarity. Results include complete signatures and marked, untrusted documentation excerpts."
    )
  );

const subpathsCommand = Command.make(
  "subpaths",
  { ...targetFlags, specifier },
  (options) =>
    runCliTargetInspection(
      "public-subpath-discovery",
      options,
      options.specifier,
      (target) => target
    )
).pipe(
  Command.withDescription(
    "List public subpaths exposed by the package manifest."
  )
);

const capabilitiesCommand = Command.make(
  "capabilities",
  outputFlags,
  (options) =>
    Effect.sync(() => {
      process.stdout.write(
        `${serializeTerminalSafeJson(inspectCapabilities(), options.pretty)}\n`
      );
    })
).pipe(
  Command.withDescription(
    "List supported protocol requests and limits as JSON. Capability output is always JSON. Pass --json to select machine-mode diagnostics; add --pretty for indented output."
  )
);

const closeProtocolExchange = (
  scope: Scope.Closeable,
  exchange: Promise<number>
) =>
  Scope.close(scope, Exit.void).pipe(
    Effect.andThen(
      Effect.promise(async () => {
        try {
          await exchange;
        } catch {
          /* The command reports exchange failures. */
        }
      })
    )
  );

const protocolCommand = Command.make("protocol", {}, () =>
  Effect.scoped(
    Effect.gen(function* runProtocol() {
      const scope = yield* Effect.acquireRelease(Scope.make(), Scope.close);

      const signal = yield* Effect.abortSignal.pipe(
        Effect.provideService(Scope.Scope, scope)
      );

      const exchange = runProtocolWireStream(
        process.stdin,
        process.stdout,
        signal
      );

      yield* Effect.addFinalizer(() => closeProtocolExchange(scope, exchange));

      const exitCode = yield* Effect.tryPromise({
        catch: (error) =>
          new ProtocolExchangeError({
            message: error instanceof Error ? error.message : String(error),
          }),
        try: async () => await exchange,
      });

      process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);
    })
  )
).pipe(
  Command.withDescription(
    "Invoke the Inspection Protocol with JSON request lines on stdin. Emit one compact JSON response line per request, in order, until stdin closes. Each line may contain at most 32 KiB of UTF-8 JSON; the final newline is optional. Empty input closes without a response. Invalid wire input ends the stream; inspection failures allow further requests and leave exit status 1. Run typepeek capabilities --json first to discover valid requests, response options, and recovery limits."
  )
);

const compareCommand = Command.make(
  "compare",
  {
    ...outputFlags,
    afterAccess: Flag.Literals("after-access", ["import", "require"]).pipe(
      Flag.withDefault("import")
    ),
    afterWorkspace: workspaceFlag(
      "after-workspace",
      "Consuming workspace for the after Interface Overview."
    ),
    args: [
      Argument.String("before-specifier"),
      Argument.String("after-specifier"),
    ],
    beforeAccess: Flag.Literals("before-access", ["import", "require"]).pipe(
      Flag.withDefault("import")
    ),
    beforeWorkspace: workspaceFlag(
      "before-workspace",
      "Consuming workspace for the before Interface Overview."
    ),
  },
  Effect.fnUntraced(function* compareCommand(options) {
    const beforeResolutionContext = resolutionContextForSpecifier(
      options.args[0],
      options.beforeWorkspace,
      "--before-workspace"
    );

    if (beforeResolutionContext instanceof Error) {
      return yield* Effect.fail(beforeResolutionContext);
    }

    const afterResolutionContext = resolutionContextForSpecifier(
      options.args[1],
      options.afterWorkspace,
      "--after-workspace"
    );

    if (afterResolutionContext instanceof Error) {
      return yield* Effect.fail(afterResolutionContext);
    }

    const outcome = yield* invokeCliInspection("public-interface-comparison", {
      after: {
        accessStyle: options.afterAccess,
        resolutionContext: afterResolutionContext,
        specifier: options.args[1],
      },
      before: {
        accessStyle: options.beforeAccess,
        resolutionContext: beforeResolutionContext,
        specifier: options.args[0],
      },
    });

    const error = writeCliOutcome(options, outcome);

    if (error !== undefined) {
      return yield* Effect.fail(error);
    }

    return yield* Effect.void;
  })
).pipe(
  Command.withDescription(
    "Compare export names and public subpaths in two complete indexes. Example: typepeek compare zod zod --before-workspace old --after-workspace new."
  )
);

const root = Command.make("typepeek").pipe(
  Command.withDescription(
    "Inspect TypeScript interfaces from installed packages and Node platform modules. Use overview or search to find exports, discover to match names and attached documentation with signatures, subpaths to find public entrypoints, and members to find public members. Inspect signatures, declarations, or a member for details; use export to include documentation and supporting types. Run known queries together with plan, or compare export names and subpaths with compare. For machine integration, run capabilities before sending requests to protocol. Common flags may precede or follow an explicit inspection command."
  ),
  Command.withSubcommands([
    overviewCommand,
    exportCommand,
    signaturesCommand,
    declarationsCommand,
    memberCommand,
    membersCommand,
    planCommand,
    exportSearchCommand("search"),
    exportSearchCommand("discover"),
    subpathsCommand,
    capabilitiesCommand,
    protocolCommand,
    compareCommand,
  ])
);

export const runCli = createCliRunner(root);
