import { Schema } from "effect";

import type { TimedCodexEvent } from "./acquisition.ts";

const secondsSchema = Schema.NullOr(
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
);

export const taskTimingSchema = Schema.Struct({
  commandSeconds: secondsSchema,
  outsideToolsSeconds: secondsSchema,
  reason: Schema.NullOr(Schema.String),
  taskSeconds: secondsSchema,
  toolCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  toolSeconds: secondsSchema,
});

export type TaskTiming = typeof taskTimingSchema.Type;

const submissionSchema = Schema.Struct({
  method: Schema.Literal("benchmark/taskSubmitted"),
  params: Schema.Struct({ threadId: Schema.String }),
});

const rawSchema = Schema.Struct({
  method: Schema.Literal("rawResponseItem/completed"),
  params: Schema.Struct({
    item: Schema.Struct({ call_id: Schema.String, type: Schema.String }),
    threadId: Schema.String,
  }),
});

const completionSchema = Schema.Struct({
  method: Schema.Literal("turn/completed"),
  params: Schema.Struct({
    threadId: Schema.String,
    turn: Schema.Struct({ status: Schema.String }),
  }),
});

const commandSchema = Schema.Struct({
  method: Schema.Literal("item/completed"),
  params: Schema.Struct({
    item: Schema.Struct({
      durationMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      type: Schema.Literal("commandExecution"),
    }),
  }),
});

class TaskTimeline {
  private submitted: number | undefined;
  private completed: number | undefined;
  private thread: string | undefined;
  private previous = 0;
  private reason: string | null = null;
  private commandMilliseconds: number | null = 0;
  private commands = 0;
  private readonly requests = new Map<string, number>();
  private readonly returned = new Set<string>();
  private readonly intervals: [number, number][] = [];

  private stop(reason: string): true {
    this.reason = reason;

    return true;
  }

  private observeTool(
    event: typeof rawSchema.Type,
    milliseconds: number
  ): boolean {
    const { item } = event.params;

    if (event.params.threadId !== this.thread) {
      return this.stop("Mixed task identities.");
    }

    if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (this.requests.has(item.call_id)) {
        return this.stop("Duplicate tool request.");
      }

      this.requests.set(item.call_id, milliseconds);
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      const start = this.requests.get(item.call_id);

      if (start === undefined || this.returned.has(item.call_id)) {
        return this.stop("Tool response has no unique request.");
      }

      this.returned.add(item.call_id);
      this.intervals.push([start, milliseconds]);
    }

    return false;
  }

  private observeCommand(duration: number | null | undefined): void {
    this.commands += 1;

    if (duration === null || duration === undefined || duration < 0) {
      this.commandMilliseconds = null;
    } else if (this.commandMilliseconds !== null) {
      this.commandMilliseconds += duration;
    }
  }

  observe({ event, milliseconds }: TimedCodexEvent): boolean {
    if (milliseconds < this.previous || !Number.isFinite(milliseconds)) {
      return this.stop("Non-monotonic task timestamps.");
    }

    this.previous = milliseconds;

    if (Schema.is(submissionSchema)(event)) {
      if (this.submitted !== undefined) {
        return this.stop("Duplicate task submission.");
      }

      this.submitted = milliseconds;
      this.thread = event.params.threadId;
    } else if (Schema.is(completionSchema)(event)) {
      if (
        this.submitted === undefined ||
        event.params.threadId !== this.thread ||
        event.params.turn.status !== "completed"
      ) {
        return this.stop("Task did not complete with matching submission.");
      }

      this.completed = milliseconds;

      return true;
    } else if (this.submitted !== undefined) {
      if (Schema.is(rawSchema)(event)) {
        return this.observeTool(event, milliseconds);
      }

      if (Schema.is(commandSchema)(event)) {
        this.observeCommand(event.params.item.durationMs);
      }
    }

    return false;
  }

  private incomplete(reason: string): TaskTiming {
    return {
      commandSeconds: null,
      outsideToolsSeconds: null,
      reason,
      taskSeconds: null,
      toolCalls: this.requests.size,
      toolSeconds: null,
    };
  }

  result(): TaskTiming {
    if (this.reason !== null) {
      return this.incomplete(this.reason);
    }

    const { submitted, completed } = this;

    if (submitted === undefined || completed === undefined) {
      return this.incomplete("Task submission or completion is missing.");
    }

    if (this.requests.size !== this.returned.size) {
      return this.incomplete("Tool calls are incomplete.");
    }

    let end = submitted;
    let toolMilliseconds = 0;

    for (const [start, finish] of this.intervals.toSorted(
      (a, b) => a[0] - b[0]
    )) {
      toolMilliseconds += Math.max(0, finish - Math.max(start, end));
      end = Math.max(end, finish);
    }

    const taskSeconds = (completed - submitted) / 1000;
    const toolSeconds = toolMilliseconds / 1000;

    return {
      commandSeconds:
        this.commands === 0 || this.commandMilliseconds === null
          ? null
          : this.commandMilliseconds / 1000,
      outsideToolsSeconds: Math.max(0, taskSeconds - toolSeconds),
      reason: null,
      taskSeconds,
      toolCalls: this.requests.size,
      toolSeconds,
    };
  }
}

/** Measures the task through its final answer; overlapping calls count once. */
export const measureTaskTiming = function measureTaskTiming(
  events: readonly TimedCodexEvent[]
): TaskTiming {
  const timeline = new TaskTimeline();

  for (const event of events) {
    if (timeline.observe(event)) {
      break;
    }
  }

  return timeline.result();
};
