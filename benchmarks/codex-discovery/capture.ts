import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { Predicate, Schema } from "effect";
import { execa } from "execa";

import type { JsonInput } from "#typepeek/json-data";
import { decodeJson } from "#typepeek/json-data";

import type { TimedCodexEvent } from "./acquisition.ts";

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

const threadSchema = Schema.Struct({
  activePermissionProfile: Schema.Struct({ id: Schema.Literal("discovery") }),
  instructionSources: Schema.Array(Schema.String),
  model: Schema.String,
  thread: Schema.Struct({ id: Schema.String }),
});

const skillsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      errors: Schema.Array(Schema.Unknown),
      skills: Schema.Array(Schema.Struct({ path: Schema.String })),
    })
  ),
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

type CodexFailureKind = "protocol" | "turn" | "process" | "cleanup";

export const captureCodex = async function captureCodex(launch: CodexLaunch) {
  const started = performance.now();
  const events: TimedCodexEvent[] = [];

  const child = execa(
    "codex",
    ["app-server", "--stdio", ...launch.configArguments],
    {
      forceKillAfterDelay: 1000,
      maxBuffer: 32 * 1024 * 1024,
      reject: false,
      stdin: "pipe",
      timeout: launch.timeoutMilliseconds,
      ...(launch.codexHome !== undefined && {
        env: { CODEX_HOME: launch.codexHome },
      }),
    }
  );

  const lines = createInterface({ input: child.stdout });
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

  let sequence = 0;
  let threadId: string | undefined;
  let answer = "";
  let turnCompletedMilliseconds: number | null = null;
  let error: string | null = null;
  let failureKind: CodexFailureKind | null = null;
  let cleaningTerminals = false;

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

  const send = (value: JsonInput) =>
    child.stdin.write(`${JSON.stringify(value)}\n`);

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

  const resolveResponse = (message: typeof messageSchema.Type): void => {
    if (Predicate.isNumber(message.id)) {
      const response = pending.get(message.id);

      if (response !== undefined) {
        pending.delete(message.id);

        if (message.error === undefined) {
          response.resolve(message.result);
        } else {
          response.reject(new Error(message.error.message));
        }
      }
    }
  };

  lines.on("line", (line) => {
    const milliseconds = performance.now() - started;

    try {
      const event = decodeJson(Schema.MutableJson, line);
      events.push({ event, milliseconds });
      const message = Schema.decodeUnknownSync(messageSchema)(event);

      if (
        message.method === "rawResponseItem/completed" &&
        JSON.stringify(message.params).includes("<skills_instructions>")
      ) {
        throw new Error(
          "Host skill instructions leaked into the benchmark thread."
        );
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
        throw new Error(`Unexpected server request: ${message.method}`);
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
        const completion = Schema.decodeUnknownSync(turnSchema)(message.params);

        if (completion.threadId !== threadId) {
          throw new Error("Received another thread's turn.");
        }

        turnCompletedMilliseconds = milliseconds;

        if (completion.turn.status === "completed") {
          finished.resolve(undefined);
        } else {
          fail(
            new Error(
              completion.turn.error?.message ?? `Turn ${completion.turn.status}`
            ),
            "turn"
          );
        }
      }
    } catch (caughtError) {
      fail(
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError))
      );
      child.kill();
    }
  });

  const observeExit = async (): Promise<void> => {
    const result = await child;

    if (turnCompletedMilliseconds === null || pending.size > 0) {
      fail(
        new Error(
          result.shortMessage ?? "Codex exited before completing the turn."
        ),
        "process"
      );
    }
  };

  void observeExit();

  try {
    await request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "typepeek_benchmark", version: "1" },
    });
    send({ method: "initialized", params: {} });

    const skills = Schema.decodeUnknownSync(skillsSchema)(
      await request("skills/list", {
        cwds: [launch.workspace],
        forceReload: true,
      })
    );

    if (skills.data.some(({ errors }) => errors.length > 0)) {
      throw new Error("Host skill discovery failed; cannot verify isolation.");
    }

    const thread = Schema.decodeUnknownSync(threadSchema)(
      await request("thread/start", {
        allowProviderModelFallback: false,
        approvalPolicy: "never",
        config: {
          "skills.config": skills.data.flatMap(({ skills: availableSkills }) =>
            availableSkills.map(({ path }) => ({ enabled: false, path }))
          ),
        },
        cwd: launch.workspace,
        ephemeral: true,
        experimentalRawEvents: true,
        model: launch.model,
        permissions: "discovery",
      })
    );

    if (thread.model !== launch.model) {
      throw new Error("Codex substituted the requested model.");
    }

    if (thread.instructionSources.length !== 0) {
      throw new Error("Host instructions leaked into the benchmark thread.");
    }

    threadId = thread.thread.id;
    events.push({
      event: { method: "benchmark/taskSubmitted", params: { threadId } },
      milliseconds: performance.now() - started,
    });
    await request("turn/start", {
      effort: launch.effort,
      input: [{ text: launch.prompt, type: "text" }],
      threadId,
      ...(launch.outputSchema !== undefined && {
        outputSchema: launch.outputSchema,
      }),
    });
    await finished.promise;
    cleaningTerminals = true;
    await request("thread/backgroundTerminals/clean", { threadId });
  } catch (caughtError) {
    fail(
      caughtError instanceof Error
        ? caughtError
        : new Error(String(caughtError)),
      cleaningTerminals ? "cleanup" : "protocol"
    );
    child.kill();
  } finally {
    child.stdin.end();
  }

  const result = await child;
  lines.close();

  return {
    answer,
    error:
      error ??
      (result.failed ? (result.shortMessage ?? "Codex failed.") : null),
    events,
    exitCode: result.exitCode ?? null,
    failureKind,
    processSeconds: (performance.now() - started) / 1000,
    stderr: result.stderr,
    timedOut: result.timedOut,
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
    throw new Error(
      "Usage: capture.ts --launch launch.json --output EMPTY_DIRECTORY"
    );
  }

  const launch = Schema.decodeSync(Schema.fromJsonString(launchSchema))(
    await readFile(values.launch, "utf-8")
  );

  await mkdir(values.output, { recursive: true });

  const readdirResult = await readdir(values.output);

  if (readdirResult.length !== 0) {
    throw new Error("Use an empty capture directory.");
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
