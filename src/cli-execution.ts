import { buildApplication, help, run, version } from "@stricli/core";
import type {
  ApplicationContext,
  RouteMap,
  StricliProcess,
} from "@stricli/core";
import { Predicate } from "effect";

import { InspectionFailureError } from "#typepeek/inspection-failure-error";
import { InvalidInvocationError } from "#typepeek/invalid-invocation-error";
import {
  serializeTerminalSafeJson,
  terminalSafeLine,
} from "#typepeek/output-safety";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";

interface CliExitState {
  value: number | string | null;
}

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

/** Owns option normalization, bounded diagnostics, exit classification and CLI execution. */
export const createCliRunner = function createCliRunner(
  rootRoute: RouteMap<ApplicationContext>
) {
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

  return async function runCli(rawInputs: readonly string[]): Promise<void> {
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
};
