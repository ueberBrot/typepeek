import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { parseArgs } from "node:util";

import { Cause, Effect, Exit, Predicate, Queue, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";

import type { JsonInput } from "#typepeek/json-data";
import { decodeJson } from "#typepeek/json-data";
import { nodeProcessLayer, scopedProcess } from "#typepeek/node-process";
import {
  boundedProcessOutput,
  collectProcessOutput,
} from "#typepeek/process-output";

import type { TimedCodexEvent } from "./acquisition.ts";
import { runCodexExchange } from "./exchange.ts";

const taggedError = Schema.TaggedError;

class CodexCaptureError extends taggedError<
  CodexCaptureError,
  { readonly brand: unique symbol }
>()("CodexCaptureError", { message: Schema.String }) {}

const launchSchema = Schema.Struct({
  codexHome: Schema.optional(Schema.String),
  configArguments: Schema.Array(Schema.String),
  effort: Schema.Literals(["low", "high"]),
  model: Schema.String,
  outputSchema: Schema.optional(Schema.Json),
  prompt: Schema.String,
  timeoutMilliseconds: Schema.Int.check(Schema.isGreaterThan(0)),
  workspace: Schema.String,
});

export type CodexLaunch = typeof launchSchema.Type;

const messageSchema = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Json),
  result: Schema.optional(Schema.Json),
});

const turnSchema = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    error: Schema.optional(
      Schema.NullOr(Schema.Struct({ message: Schema.String }))
    ),
    id: Schema.String,
    status: Schema.String,
  }),
});

const answerSchema = Schema.Struct({
  item: Schema.Struct({
    phase: Schema.optional(Schema.NullOr(Schema.String)),
    text: Schema.String,
    type: Schema.Literal("agentMessage"),
  }),
  threadId: Schema.String,
});

interface CodexProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

type CodexFailureKind = "protocol" | "turn" | "process" | "cleanup";

export const captureCodex = async function captureCodex(launch: CodexLaunch) {
  const started = performance.now();
  const events: TimedCodexEvent[] = [];

  let processResult: CodexProcessResult = { exitCode: null, stderr: "" };
  let timedOut = false;
  let sequence = 0;
  let threadId: string | undefined;
  let answer = "";
  let turnCompletedMilliseconds: number | null = null;
  let error: string | null = null;
  let failureKind: CodexFailureKind | null = null;
  let cleaningTerminals = false;

  const finished = Promise.withResolvers<undefined>();
  // The request path observes this rejection after initialization and cleanup.
  void finished.promise.catch(() => null);

  const pending = new Map<
    number,
    {
      resolve: (value: Schema.Json | undefined) => void;
      reject: (error: Error) => void;
    }
  >();

  const fail = (
    cause: Error,
    kind: NonNullable<typeof failureKind> = "protocol"
  ) => {
    if (error === null) {
      error = cause.message;
      failureKind = kind;
    }

    for (const request of pending.values()) {
      request.reject(cause);
    }

    pending.clear();
    finished.reject(cause);
  };

  const resolveResponse = (message: typeof messageSchema.Type): void => {
    if (Predicate.isNumber(message.id)) {
      const response = pending.get(message.id);

      if (response !== undefined) {
        pending.delete(message.id);

        if (message.error === undefined) {
          response.resolve(message.result);
        } else {
          response.reject(
            new CodexCaptureError({ message: message.error.message })
          );
        }
      }
    }
  };

  const onAbort = () => {
    fail(
      new CodexCaptureError({ message: "Codex exchange interrupted." }),
      "process"
    );
  };

  const execution = Effect.scoped(
    Effect.gen(function* execution() {
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();

      const child = yield* scopedProcess(
        ChildProcess.make(
          "codex",
          ["app-server", "--stdio", ...launch.configArguments],
          {
            forceKillAfter: 1000,
            stdin: Stream.fromQueue(input),
            ...(launch.codexHome !== undefined && {
              env: { CODEX_HOME: launch.codexHome },
              extendEnv: true,
            }),
          }
        )
      );

      const send = (value: JsonInput) =>
        Queue.offerUnsafe(input, Buffer.from(`${JSON.stringify(value)}\n`));

      const request = async (
        method: string,
        params: JsonInput
      ): Promise<Schema.Json | undefined> => {
        const pendingRequest = Promise.withResolvers<Schema.Json | undefined>();
        const id = sequence;
        sequence += 1;
        pending.set(id, pendingRequest);
        send({ id, method, params });

        return await pendingRequest.promise;
      };

      const acceptLine = (line: string): void => {
        const milliseconds = performance.now() - started;

        try {
          const event = decodeJson(Schema.MutableJson, line);
          events.push({ event, milliseconds });
          const message = Schema.decodeUnknownSync(messageSchema)(event);

          if (
            message.method === "rawResponseItem/completed" &&
            JSON.stringify(message.params).includes("<skills_instructions>")
          ) {
            throw new CodexCaptureError({
              message:
                "Host skill instructions leaked into the benchmark thread.",
            });
          }

          if (message.id !== undefined && message.method !== undefined) {
            send({
              error: {
                code: -32_601,
                message:
                  "Benchmark does not grant requests or additional permissions.",
              },
              id: message.id,
            });
            throw new CodexCaptureError({
              message: `Unexpected server request: ${message.method}`,
            });
          }

          resolveResponse(message);

          if (
            message.method === "item/completed" &&
            Schema.is(answerSchema)(message.params) &&
            message.params.threadId === threadId &&
            message.params.item.phase !== "commentary"
          ) {
            answer = message.params.item.text;
          }

          if (message.method === "turn/completed") {
            const completion = Schema.decodeUnknownSync(turnSchema)(
              message.params
            );

            if (completion.threadId !== threadId) {
              throw new CodexCaptureError({
                message: "Received another thread's turn.",
              });
            }

            turnCompletedMilliseconds = milliseconds;

            if (completion.turn.status === "completed") {
              finished.resolve(undefined);
            } else {
              fail(
                new CodexCaptureError({
                  message:
                    completion.turn.error?.message ??
                    `Turn ${completion.turn.status}`,
                }),
                "turn"
              );
            }
          }
        } catch (caughtError) {
          fail(
            caughtError instanceof Error
              ? caughtError
              : new CodexCaptureError({ message: String(caughtError) })
          );
        }
      };

      const capture = Effect.all(
        {
          exit: child.exitCode,
          output: boundedProcessOutput(child.stdout, 32 * 1024 * 1024).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                acceptLine(line);
              })
            )
          ),
          stderr: collectProcessOutput(child.stderr, 32 * 1024 * 1024),
        },
        { concurrency: "unbounded" }
      ).pipe(
        Effect.tap(({ exit, stderr }) =>
          Effect.sync(() => {
            processResult = {
              exitCode: Exit.isSuccess(exit) ? Number(exit.value) : null,
              stderr: stderr.toString("utf-8"),
            };

            if (turnCompletedMilliseconds === null || pending.size > 0) {
              fail(
                new CodexCaptureError({
                  message: "Codex exited before completing the turn.",
                }),
                "process"
              );
            }
          })
        )
      );

      const exchange = Effect.tryPromise({
        catch: (cause) =>
          new CodexCaptureError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        try: async (signal) => {
          signal.addEventListener("abort", onAbort, { once: true });

          try {
            await runCodexExchange({
              finished: finished.promise,
              launch,
              onCleanup: () => {
                cleaningTerminals = true;
              },
              onSubmit: (id) => {
                threadId = id;
                events.push({
                  event: {
                    method: "benchmark/taskSubmitted",
                    params: { threadId: id },
                  },
                  milliseconds: performance.now() - started,
                });
              },
              request,
              send,
            });
          } finally {
            Queue.endUnsafe(input);
            signal.removeEventListener("abort", onAbort);
          }
        },
      }).pipe(
        Effect.catchTag("CodexCaptureError", (cause) =>
          Effect.gen(function* stopFailedExchange() {
            fail(cause, cleaningTerminals ? "cleanup" : "protocol");
            yield* child.kill({ forceKillAfter: 1000 }).pipe(Effect.ignore);
          })
        )
      );

      yield* Effect.all([capture, exchange], { concurrency: "unbounded" });
    })
  );

  await Effect.runPromise(
    execution.pipe(
      Effect.timeoutOrElse({
        duration: launch.timeoutMilliseconds,
        orElse: () =>
          Effect.sync(() => {
            timedOut = true;
            fail(
              new CodexCaptureError({
                message: "Codex exceeded its process deadline.",
              }),
              "process"
            );
          }),
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fail(
            new CodexCaptureError({ message: Cause.pretty(cause) }),
            "process"
          );
        })
      ),
      Effect.provide(nodeProcessLayer)
    )
  );

  return {
    answer,
    error: error ?? (processResult.exitCode === 0 ? null : "Codex failed."),
    events,
    exitCode: processResult.exitCode,
    failureKind,
    processSeconds: (performance.now() - started) / 1000,
    stderr: processResult.stderr,
    timedOut,
    turnCompletedMilliseconds,
  };
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: { launch: { type: "string" }, output: { type: "string" } },
  });

  if (
    values.launch === undefined ||
    values.launch === "" ||
    values.output === undefined ||
    values.output === ""
  ) {
    throw new CodexCaptureError({
      message:
        "Usage: capture.ts --launch launch.json --output EMPTY_DIRECTORY",
    });
  }

  const launch = Schema.decodeSync(Schema.fromJsonString(launchSchema))(
    await readFile(values.launch, "utf-8")
  );

  await mkdir(values.output, { recursive: true });

  const readdirResult = await readdir(values.output);

  if (readdirResult.length !== 0) {
    throw new CodexCaptureError({ message: "Use an empty capture directory." });
  }

  const { events, stderr, ...result } = await captureCodex(launch);
  await writeFile(
    nodePath.join(values.output, "events.timed.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
  await writeFile(nodePath.join(values.output, "stderr.txt"), stderr);
  await writeFile(
    nodePath.join(values.output, "capture.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );

  if (result.error !== null) {
    process.exitCode = 1;
  }
}
