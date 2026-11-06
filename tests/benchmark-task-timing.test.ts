import { describe, expect, it } from "vite-plus/test";

import { measureTaskTiming } from "../benchmarks/codex-discovery/task-timing.ts";

const submitted = {
  event: {
    method: "benchmark/taskSubmitted",
    params: { threadId: "task" },
  },
  milliseconds: 1000,
};

const completed = {
  event: {
    method: "turn/completed",
    params: { threadId: "task", turn: { status: "completed" } },
  },
  milliseconds: 8000,
};

const tool = (milliseconds: number, id: string, returned = false) => ({
  event: {
    method: "rawResponseItem/completed",
    params: {
      item: {
        call_id: id,
        type: returned ? "function_call_output" : "function_call",
      },
      threadId: "task",
    },
  },
  milliseconds,
});

describe("benchmark task timing", () => {
  it("includes final-answer time and counts overlapping tool waits once", () => {
    expect(
      measureTaskTiming([
        submitted,
        tool(2000, "first"),
        tool(3000, "second"),
        tool(5000, "first", true),
        tool(6000, "second", true),
        completed,
      ])
    ).toStrictEqual({
      commandSeconds: null,
      outsideToolsSeconds: 3,
      reason: null,
      taskSeconds: 7,
      toolCalls: 2,
      toolSeconds: 4,
    });
  });

  it("records zero tools without equating outside-tool time with inference", () => {
    expect(measureTaskTiming([submitted, completed])).toMatchObject({
      outsideToolsSeconds: 7,
      taskSeconds: 7,
      toolCalls: 0,
      toolSeconds: 0,
    });
  });

  it("leaves incomplete timing unknown", () => {
    for (const events of [
      [completed],
      [submitted, tool(2000, "missing"), completed],
      [submitted, tool(2000, "unrequested", true), completed],
    ]) {
      expect(measureTaskTiming(events)).toMatchObject({
        outsideToolsSeconds: null,
        taskSeconds: null,
        toolSeconds: null,
      });
    }
  });

  it("keeps missing command duration unknown without losing task timing", () => {
    expect(
      measureTaskTiming([
        submitted,
        {
          event: {
            method: "item/completed",
            params: { item: { type: "commandExecution" } },
          },
          milliseconds: 2000,
        },
        completed,
      ])
    ).toMatchObject({ commandSeconds: null, taskSeconds: 7 });
  });
});
