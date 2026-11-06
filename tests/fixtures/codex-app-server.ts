#!/usr/bin/env node
import nodePath from "node:path";
import { createInterface } from "node:readline";

import { Schema } from "effect";

const TURN_COMPLETED = "turn/completed";

if (process.argv[2] === "--version") {
  console.log("codex-fixture");
  process.exit(0);
}

if (process.argv[2] === "sandbox") {
  const workspace = process.argv[process.argv.indexOf("--cd") + 1];

  if (workspace === undefined) {
    throw new Error("Isolation preflight requires a workspace.");
  }

  if (
    process.env["CODEX_HOME"] !==
    nodePath.join(nodePath.dirname(workspace), "codex")
  ) {
    throw new Error(
      "Isolation preflight must use the trial's isolated Codex configuration"
    );
  }

  console.log("isolation verified");
  process.exit(0);
}

const send = (message: Schema.Json): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const raw = (item: Schema.Json): void => {
  send({
    method: "rawResponseItem/completed",
    params: { item, threadId: "thread", turnId: "turn" },
  });
};

const requestSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.JsonObject),
});

const initializeParametersSchema = Schema.Struct({
  capabilities: Schema.Struct({ experimentalApi: Schema.Boolean }),
});

const threadParametersSchema = Schema.Struct({
  config: Schema.Struct({
    "skills.config": Schema.Array(Schema.Struct({ enabled: Schema.Boolean })),
  }),
  ephemeral: Schema.Boolean,
  experimentalRawEvents: Schema.Boolean,
  model: Schema.String,
});

const handleRequest = (request: typeof requestSchema.Type): void => {
  if (request.id === undefined) {
    return;
  }

  if (request.method === "initialize") {
    const parameters = Schema.decodeUnknownSync(initializeParametersSchema)(
      request.params
    );

    if (!parameters.capabilities.experimentalApi) {
      throw new Error("Raw events require opt-in");
    }

    if (process.env["CODEX_FIXTURE_NONFINITE_ID"] === "1") {
      process.stdout.write('{"id":1e999,"result":{}}\n');

      return;
    }

    send({ id: request.id, result: {} });
  } else if (request.method === "skills/list") {
    send({
      id: request.id,
      result: {
        data: [{ errors: [], skills: [{ path: "/fixture/host/SKILL.md" }] }],
      },
    });
  } else if (request.method === "thread/start") {
    const parameters = Schema.decodeUnknownSync(threadParametersSchema)(
      request.params
    );

    if (parameters.config["skills.config"][0]?.enabled !== false) {
      throw new Error("Host skills must be disabled");
    }

    if (!parameters.ephemeral || !parameters.experimentalRawEvents) {
      throw new Error("Expected ephemeral raw-event thread");
    }

    send({
      id: request.id,
      result: {
        activePermissionProfile: { id: "discovery" },
        instructionSources: [],
        model: parameters.model,
        thread: { id: "thread" },
      },
    });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn" } } });
    send({
      method: "rawResponse/completed",
      params: {
        responseId: "lookup",
        threadId: "thread",
        turnId: "turn",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 100,
          outputTokens: 20,
          reasoningOutputTokens: 0,
        },
      },
    });

    if (process.env["CODEX_FIXTURE_FAIL_EARLY"] === "1") {
      send({
        method: TURN_COMPLETED,
        params: {
          threadId: "thread",
          turn: {
            error: { message: "Early model failure" },
            id: "turn",
            status: "failed",
          },
        },
      });

      return;
    }

    raw({
      arguments: '{"cmd":"read declaration"}',
      call_id: "read",
      name: "exec_command",
      type: "function_call",
    });
    send({
      method: "item/completed",
      params: {
        item: {
          aggregatedOutput:
            "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;",
          command: "read declaration",
          durationMs: 10,
          exitCode: 0,
          id: "read",
          type: "commandExecution",
        },
        threadId: "thread",
        turnId: "turn",
      },
    });
    setTimeout(() => {
      raw({
        call_id: "read",
        output:
          "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;",
        type: "function_call_output",
      });
    }, 20);
    setTimeout(() => {
      send({
        method: "item/completed",
        params: {
          item: {
            id: "answer",
            phase: "final_answer",
            text: "A late final answer",
            type: "agentMessage",
          },
          threadId: "thread",
          turnId: "turn",
        },
      });
      send({
        method: TURN_COMPLETED,
        params: {
          threadId: "thread",
          turn: {
            error:
              process.env["CODEX_FIXTURE_FAIL_LATE"] === "1"
                ? { message: "Late model failure" }
                : null,
            id: "turn",
            status:
              process.env["CODEX_FIXTURE_FAIL_LATE"] === "1"
                ? "failed"
                : "completed",
          },
        },
      });
    }, 180);
  } else if (
    request.method === "thread/backgroundTerminals/clean" &&
    process.env["CODEX_FIXTURE_CROSS_THREAD_CLEANUP"] === "1"
  ) {
    send({
      method: TURN_COMPLETED,
      params: { threadId: "other", turn: { id: "turn", status: "completed" } },
    });
  } else if (
    request.method === "thread/backgroundTerminals/clean" &&
    process.env["CODEX_FIXTURE_FAIL_CLEANUP"] === "1"
  ) {
    send({ error: { message: "Terminal cleanup failed" }, id: request.id });
  } else {
    send({ id: request.id, result: {} });
  }
};

for await (const line of createInterface({ input: process.stdin })) {
  const request = Schema.decodeSync(Schema.fromJsonString(requestSchema))(line);
  handleRequest(request);
}
