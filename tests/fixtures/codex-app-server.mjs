#!/usr/bin/env node
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  console.log("codex-fixture");
  process.exit(0);
}
if (process.argv[2] === "sandbox") {
  const workspace = process.argv[process.argv.indexOf("--cd") + 1];
  if (process.env.CODEX_HOME !== join(dirname(workspace), "codex"))
    throw new Error("Isolation preflight must use the trial's isolated Codex configuration");
  console.log("isolation verified");
  process.exit(0);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const raw = (item) =>
  send({
    method: "rawResponseItem/completed",
    params: { threadId: "thread", turnId: "turn", item },
  });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (request.params.capabilities.experimentalApi !== true)
      throw new Error("Raw events require opt-in");
    send({ id: request.id, result: {} });
  } else if (request.method === "skills/list") {
    send({
      id: request.id,
      result: { data: [{ skills: [{ path: "/fixture/host/SKILL.md" }], errors: [] }] },
    });
  } else if (request.method === "thread/start") {
    if (request.params.config?.["skills.config"]?.[0]?.enabled !== false)
      throw new Error("Host skills must be disabled");
    if (!request.params.ephemeral || !request.params.experimentalRawEvents)
      throw new Error("Expected ephemeral raw-event thread");
    send({
      id: request.id,
      result: {
        thread: { id: "thread" },
        model: request.params.model,
        activePermissionProfile: { id: "discovery" },
        instructionSources: [],
      },
    });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn" } } });
    send({
      method: "rawResponse/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        responseId: "lookup",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    });
    if (process.env.CODEX_FIXTURE_FAIL_EARLY) {
      send({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "turn", status: "failed", error: { message: "Early model failure" } },
        },
      });
      continue;
    }
    raw({
      type: "function_call",
      call_id: "read",
      name: "exec_command",
      arguments: '{"cmd":"read declaration"}',
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: "read",
          type: "commandExecution",
          command: "read declaration",
          aggregatedOutput: "export function parseCommandString(command: string): string[];",
          exitCode: 0,
          durationMs: 10,
        },
      },
    });
    setTimeout(
      () =>
        raw({
          type: "function_call_output",
          call_id: "read",
          output: "export function parseCommandString(command: string): string[];",
        }),
      20,
    );
    setTimeout(() => {
      send({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            id: "answer",
            type: "agentMessage",
            text: "A late final answer",
            phase: "final_answer",
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: {
            id: "turn",
            status: process.env.CODEX_FIXTURE_FAIL_LATE ? "failed" : "completed",
            error: process.env.CODEX_FIXTURE_FAIL_LATE ? { message: "Late model failure" } : null,
          },
        },
      });
    }, 180);
  } else if (
    request.method === "thread/backgroundTerminals/clean" &&
    process.env.CODEX_FIXTURE_CROSS_THREAD_CLEANUP
  ) {
    send({
      method: "turn/completed",
      params: { threadId: "other", turn: { id: "turn", status: "completed" } },
    });
  } else if (
    request.method === "thread/backgroundTerminals/clean" &&
    process.env.CODEX_FIXTURE_FAIL_CLEANUP
  ) {
    send({ id: request.id, error: { message: "Terminal cleanup failed" } });
  } else if (request.id !== undefined) {
    send({ id: request.id, result: {} });
  }
}
