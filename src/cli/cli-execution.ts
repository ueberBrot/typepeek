import { Cause, Effect, Option, Stdio } from "effect";
import { CliError, CliOutput, Command } from "effect/cli";
import type { PlatformError } from "effect/PlatformError";

import { InspectionFailureError } from "#typepeek/cli/inspection-failure-error";
import { InvalidInvocationError } from "#typepeek/cli/invalid-invocation-error";
import { TYPEPEEK_VERSION } from "#typepeek/platform/package-metadata";
import { cliLayer } from "#typepeek/platform/process-runtime";
import { setExitCode } from "#typepeek/platform/runtime-process";
import { writeStdout, writeStderr } from "#typepeek/platform/stdio";
import {
  serializeTerminalSafeJson,
  terminalSafeLine,
} from "#typepeek/presentation/output-safety";

const MAX_CLI_DIAGNOSTIC_BYTES = 128 * 1024;
export const INSPECTION_FAILURE_EXIT_CODE = 1;
const INVALID_INVOCATION_EXIT_CODE = 2;
const INTERNAL_ERROR_EXIT_CODE = 70;

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

const writeCapturedDiagnostic = (
  rawInputs: readonly string[],
  diagnostic: CliDiagnosticSnapshot
) =>
  requestsJson(rawInputs)
    ? writeStdout(
        `${renderCliDiagnostic(diagnostic, requestsPretty(rawInputs))}\n`
      )
    : writeStderr(renderHumanCliDiagnostic(diagnostic));

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

const diagnostic = (
  rawInputs: readonly string[],
  error: Error,
  exitCode: number
) =>
  writeCapturedDiagnostic(rawInputs, {
    exceeded: Buffer.byteLength(error.message) > MAX_CLI_DIAGNOSTIC_BYTES,
    exitCode,
    stderr: error.message,
  }).pipe(Effect.andThen(setExitCode(exitCode)));

const cliInputs = (rawInputs: readonly string[]): readonly string[] => {
  if (rawInputs.length === 0) {
    return ["--help"];
  }

  const normalized = normalizeCommonOptionPlacement(rawInputs);
  const [first] = normalized;

  if (first === undefined || INSPECTION_COMMANDS.has(first)) {
    return normalized;
  }

  const actions = new Set([
    "protocol",
    "capabilities",
    "--help",
    "-h",
    "--version",
    "-v",
    "--completions",
    "--wizard",
  ]);

  return actions.has(first) ? normalized : ["overview", ...normalized];
};

const cliPresenter = (stdio: Stdio.Stdio): CliOutput.Presenter => ({
  present: (event) => {
    if (event._tag === "Version") {
      return writeStdout(`${event.version}\n`).pipe(
        Effect.provideService(Stdio.Stdio, stdio),
        Effect.orDie
      );
    }

    if (
      event._tag === "InvalidInvocation" ||
      (event._tag === "Help" && event.reason === "Implicit")
    ) {
      return Effect.void;
    }

    return CliOutput.defaultPresenter.present(event);
  },
});

const failureExitCode = (error: Error): number => {
  if (error instanceof InvalidInvocationError) {
    return INVALID_INVOCATION_EXIT_CODE;
  }

  return error instanceof InspectionFailureError
    ? INSPECTION_FAILURE_EXIT_CODE
    : INTERNAL_ERROR_EXIT_CODE;
};

const reportCliCause = <E>(
  rawInputs: readonly string[],
  cause: Cause.Cause<E>
): Effect.Effect<void, E | PlatformError, Stdio.Stdio> => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }

  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));

  const error =
    failure instanceof Error ? failure : new Error(String(Cause.squash(cause)));

  if (CliError.isCliError(error)) {
    const message =
      error._tag === "ShowHelp"
        ? error.errors.map((entry) => entry.message).join("\n")
        : error.message;

    return diagnostic(
      rawInputs,
      new Error(message || "Invalid invocation."),
      INVALID_INVOCATION_EXIT_CODE
    );
  }

  return diagnostic(rawInputs, error, failureExitCode(error));
};

/** Owns option normalization, bounded diagnostics, exit classification and CLI execution. */
export const createCliRunner =
  <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>
  ) =>
  (rawInputs: readonly string[]) =>
    Effect.gen(function* executeCli() {
      if (requestsPretty(rawInputs) && !requestsJson(rawInputs)) {
        return yield* diagnostic(
          rawInputs,
          new InvalidInvocationError({ message: "--pretty requires --json." }),
          INVALID_INVOCATION_EXIT_CODE
        );
      }

      const stdio = yield* Stdio.Stdio;

      return yield* Command.runWith(command, { version: TYPEPEEK_VERSION })(
        cliInputs(rawInputs)
      ).pipe(
        Effect.provideService(CliOutput.Presenter, cliPresenter(stdio)),
        Effect.catchCause((cause) => reportCliCause(rawInputs, cause))
      );
    }).pipe(Effect.provide(cliLayer));
