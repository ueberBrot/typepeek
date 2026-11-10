import { Duration, Effect, Exit, Predicate, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";

import { processExecutable } from "#typepeek/platform/process-executable";
import {
  processLayer,
  scopedProcess,
} from "#typepeek/platform/process-runtime";
import { collectByteStream } from "#typepeek/shared/byte-stream";

const taggedError = Schema.TaggedError;

class CommandExecutionError extends taggedError<
  CommandExecutionError,
  { readonly brand: unique symbol }
>()("CommandExecutionError", { message: Schema.String }) {}

export interface CommandCaptureOptions extends ChildProcess.CommandOptions {
  readonly input?: string | Uint8Array;
  readonly trimFinalNewline?: boolean;
  readonly reject?: boolean;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/** Capture a finite tool invocation; long-lived protocols use Effect streams directly. */
export const runCommandEffect = Effect.fnUntraced(function* runCommandEffect(
  executable: string,
  args: readonly string[],
  options: CommandCaptureOptions = {}
) {
  let stdin = options.stdin ?? "ignore";

  if (options.input !== undefined) {
    const input = Predicate.isString(options.input)
      ? Buffer.from(options.input)
      : options.input;

    stdin = Stream.make(input);
  }

  const {
    executable: commandExecutable,
    args: commandArguments,
    ...context
  } = yield* processExecutable(executable, args, options);

  const command = ChildProcess.make(commandExecutable, commandArguments, {
    ...options,
    ...context,
    extendEnv: context.extendEnv,
    forceKillAfter: options.forceKillAfter ?? 1000,
    stdin,
  });

  const execution = Effect.scoped(
    Effect.gen(function* execution() {
      const handle = yield* scopedProcess(command);

      const { exit, stdout, stderr } = yield* Effect.all(
        {
          exit: handle.exitCode,
          stderr: collectByteStream(handle.stderr, 32 * 1024 * 1024),
          stdout: collectByteStream(handle.stdout, 32 * 1024 * 1024),
        },
        { concurrency: "unbounded" }
      );

      const result = {
        exitCode: Exit.isSuccess(exit) ? Number(exit.value) : null,
        failed:
          Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value !== 0),
        stderr:
          options.trimFinalNewline === false
            ? new TextDecoder().decode(stderr)
            : new TextDecoder().decode(stderr).replace(/\r?\n$/u, ""),
        stdout:
          options.trimFinalNewline === false
            ? new TextDecoder().decode(stdout)
            : new TextDecoder().decode(stdout).replace(/\r?\n$/u, ""),
        timedOut: false,
      };

      if (result.failed && options.reject !== false) {
        return yield* new CommandExecutionError({
          message: `${executable} exited with status ${result.exitCode ?? "signal"}: ${result.stderr}`,
        });
      }

      return result;
    })
  );

  return yield* execution.pipe(
    Effect.timeoutOrElse({
      duration: options.timeout ?? Duration.infinity,
      orElse: () =>
        options.reject === false
          ? Effect.succeed({
              exitCode: null,
              failed: true,
              stderr: "Command exceeded its process deadline.",
              stdout: "",
              timedOut: true,
            })
          : Effect.fail(
              new CommandExecutionError({
                message: `${executable} exceeded its process deadline.`,
              })
            ),
    }),
    Effect.catchTag("PlatformError", (error) =>
      options.reject === false
        ? Effect.succeed({
            exitCode: null,
            failed: true,
            stderr: error.message,
            stdout: "",
            timedOut: false,
          })
        : Effect.fail(error)
    )
  );
});

/** Bridge Promise-based test and TanStack entrypoints to the native Effect process implementation. */
export const runCommand = async (
  executable: string,
  args: readonly string[],
  options: CommandCaptureOptions = {}
) =>
  await Effect.runPromise(
    runCommandEffect(executable, args, options).pipe(
      Effect.provide(processLayer)
    ),
    options.signal === undefined ? {} : { signal: options.signal }
  );
