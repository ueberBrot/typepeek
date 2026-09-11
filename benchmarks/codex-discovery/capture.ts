import { Schema } from "effect";
import { execa } from "execa";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import type { TimedCodexEvent } from "./acquisition.ts";

const launchSchema = Schema.Struct({
  workspace: Schema.String,
  model: Schema.String,
  effort: Schema.Literals(["low", "high"]),
  prompt: Schema.String,
  configArguments: Schema.Array(Schema.String),
  timeoutMilliseconds: Schema.Int.check(Schema.isGreaterThan(0)),
  codexHome: Schema.optional(Schema.String),
  outputSchema: Schema.optional(Schema.Unknown),
});
export type CodexLaunch = typeof launchSchema.Type;

const messageSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const threadSchema = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.String,
  activePermissionProfile: Schema.Struct({ id: Schema.Literal("discovery") }),
  instructionSources: Schema.Array(Schema.String),
});
const skillsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      skills: Schema.Array(Schema.Struct({ path: Schema.String })),
      errors: Schema.Array(Schema.Unknown),
    }),
  ),
});
const turnSchema = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    error: Schema.optional(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
  }),
});
const answerSchema = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Struct({
    type: Schema.Literal("agentMessage"),
    text: Schema.String,
    phase: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export async function captureCodex(launch: CodexLaunch) {
  const started = performance.now();
  const events: TimedCodexEvent[] = [];
  const child = execa("codex", ["app-server", "--stdio", ...launch.configArguments], {
    stdin: "pipe",
    reject: false,
    timeout: launch.timeoutMilliseconds,
    forceKillAfterDelay: 1000,
    maxBuffer: 32 * 1024 * 1024,
    ...(launch.codexHome === undefined ? {} : { env: { CODEX_HOME: launch.codexHome } }),
  });
  const lines = createInterface({ input: child.stdout });
  const finished = Promise.withResolvers<void>();
  void finished.promise.catch(() => {});
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  let threadId: string | undefined;
  let answer = "";
  let turnCompletedMilliseconds: number | null = null;
  let error: string | null = null;
  let failureKind: "protocol" | "turn" | "process" | null = null;
  const fail = (cause: Error, kind: "protocol" | "turn" | "process" = "protocol") => {
    if (error === null) {
      error = cause.message;
      failureKind = kind;
    }
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
    finished.reject(cause);
  };
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = sequence++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  lines.on("line", (line) => {
    const milliseconds = performance.now() - started;
    try {
      const event: unknown = JSON.parse(line);
      events.push({ milliseconds, event });
      const message = Schema.decodeUnknownSync(messageSchema)(event);
      if (
        message.method === "rawResponseItem/completed" &&
        JSON.stringify(message.params).includes("<skills_instructions>")
      )
        throw new Error("Host skill instructions leaked into the benchmark thread.");
      if (message.id !== undefined && message.method !== undefined) {
        send({
          id: message.id,
          error: {
            code: -32601,
            message: "Benchmark does not grant requests or additional permissions.",
          },
        });
        throw new Error(`Unexpected server request: ${message.method}`);
      }
      if (typeof message.id === "number") {
        const response = pending.get(message.id);
        if (response !== undefined) {
          pending.delete(message.id);
          if (message.error !== undefined) response.reject(new Error(message.error.message));
          else response.resolve(message.result);
        }
      }
      if (message.method === "item/completed" && Schema.is(answerSchema)(message.params)) {
        if (message.params.threadId === threadId && message.params.item.phase !== "commentary") {
          answer = message.params.item.text;
        }
      }
      if (message.method === "turn/completed") {
        const completion = Schema.decodeUnknownSync(turnSchema)(message.params);
        if (completion.threadId !== threadId) throw new Error("Received another thread's turn.");
        turnCompletedMilliseconds = milliseconds;
        if (completion.turn.status !== "completed") {
          fail(
            new Error(completion.turn.error?.message ?? `Turn ${completion.turn.status}`),
            "turn",
          );
        } else finished.resolve();
      }
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)));
      child.kill();
    }
  });
  void child.then((result) => {
    if (turnCompletedMilliseconds === null || pending.size > 0)
      fail(new Error(result.shortMessage ?? "Codex exited before completing the turn."), "process");
  });
  try {
    await request("initialize", {
      clientInfo: { name: "typepeek_benchmark", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    const skills = Schema.decodeUnknownSync(skillsSchema)(
      await request("skills/list", { cwds: [launch.workspace], forceReload: true }),
    );
    if (skills.data.some(({ errors }) => errors.length > 0))
      throw new Error("Host skill discovery failed; cannot verify isolation.");
    const thread = Schema.decodeUnknownSync(threadSchema)(
      await request("thread/start", {
        model: launch.model,
        cwd: launch.workspace,
        permissions: "discovery",
        approvalPolicy: "never",
        ephemeral: true,
        experimentalRawEvents: true,
        allowProviderModelFallback: false,
        config: {
          "skills.config": skills.data.flatMap(({ skills }) =>
            skills.map(({ path }) => ({ path, enabled: false })),
          ),
        },
      }),
    );
    if (thread.model !== launch.model) throw new Error("Codex substituted the requested model.");
    if (thread.instructionSources.length !== 0)
      throw new Error("Host instructions leaked into the benchmark thread.");
    threadId = thread.thread.id;
    events.push({
      milliseconds: performance.now() - started,
      event: { method: "benchmark/taskSubmitted", params: { threadId } },
    });
    await request("turn/start", {
      threadId,
      input: [{ type: "text", text: launch.prompt }],
      effort: launch.effort,
      ...(launch.outputSchema === undefined ? {} : { outputSchema: launch.outputSchema }),
    });
    await finished.promise;
    await request("thread/backgroundTerminals/clean", { threadId });
  } catch (cause) {
    fail(cause instanceof Error ? cause : new Error(String(cause)));
    child.kill();
  } finally {
    child.stdin.end();
  }
  const result = await child;
  lines.close();
  return {
    events,
    answer,
    turnCompletedMilliseconds,
    processSeconds: (performance.now() - started) / 1000,
    exitCode: result.exitCode ?? null,
    timedOut: result.timedOut,
    error: error ?? (result.failed ? (result.shortMessage ?? "Codex failed.") : null),
    failureKind,
    stderr: result.stderr,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { launch: { type: "string" }, output: { type: "string" } },
  });
  if (!values.launch || !values.output)
    throw new Error("Usage: capture.ts --launch launch.json --output EMPTY_DIRECTORY");
  const launch = Schema.decodeUnknownSync(launchSchema)(
    JSON.parse(await readFile(values.launch, "utf8")),
  );
  await mkdir(values.output, { recursive: true });
  if ((await readdir(values.output)).length !== 0)
    throw new Error("Use an empty capture directory.");
  const { events, stderr, ...result } = await captureCodex(launch);
  await writeFile(
    join(values.output, "events.timed.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  await writeFile(join(values.output, "stderr.txt"), stderr);
  await writeFile(join(values.output, "capture.json"), JSON.stringify(result, null, 2) + "\n");
  if (result.error !== null) process.exitCode = 1;
}
