import { Predicate, Schema } from "effect";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

import { requireDefined } from "#typepeek/shared/defined-value";

import type { AcquisitionOracle } from "./acquisition-evidence.ts";
import { AcquisitionEvidence } from "./acquisition-evidence.ts";

const millisecondsSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0)
);

const observationSchema = Schema.Struct({
  event: Schema.Unknown,
  milliseconds: millisecondsSchema,
});

const submissionSchema = Schema.Struct({
  method: Schema.Literal("benchmark/taskSubmitted"),
  params: Schema.Struct({ threadId: Schema.String }),
});

export type TimedCodexEvent = typeof observationSchema.Type;

const rawItemSchema = Schema.Struct({
  method: Schema.Literal("rawResponseItem/completed"),
  params: Schema.Struct({
    item: Schema.Unknown,
    threadId: Schema.String,
    turnId: Schema.String,
  }),
});

const callSchema = Schema.Struct({
  call_id: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["function_call", "custom_tool_call"]),
});

const outputSchema = Schema.Struct({
  call_id: Schema.String,
  output: Schema.Union([
    Schema.String,
    Schema.Array(
      Schema.Struct({ text: Schema.String, type: Schema.Literal("input_text") })
    ),
  ]),
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
});

const executionSchema = Schema.Struct({
  method: Schema.Literal("item/completed"),
  params: Schema.Struct({
    item: Schema.Struct({
      durationMs: millisecondsSchema,
      type: Schema.Literal("commandExecution"),
    }),
  }),
});

export const decodeTimedCodexEvents = function decodeTimedCodexEvents(
  serialized: string
): readonly TimedCodexEvent[] {
  return serialized
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      Schema.decodeSync(Schema.fromJsonString(observationSchema))(line)
    );
};

class AcquisitionMeasurement {
  started = new Map<string, number>();
  nonRetrieval = new Set<string>();
  completed = new Set<string>();
  evidenceEvents: {
    callId: string;
    milliseconds: number;
    facts: string[];
  }[] = [];
  invalidReason: string | null = null;
  previousMilliseconds = 0;
  identity: string | undefined;
  submittedThread: string | undefined;
  taskSubmittedMilliseconds: number | null = null;
  firstRequestMilliseconds: number | null = null;
  sufficientEvidenceMilliseconds: number | null = null;
  toolMilliseconds = 0;
  commandMilliseconds = 0;
  measuredCommands = 0;
  evidenceTokens = 0;
  evidenceBytes = 0;
  private readonly evidence: AcquisitionEvidence;
  constructor(oracle: AcquisitionOracle) {
    this.evidence = new AcquisitionEvidence(oracle);
  }
  observe({ milliseconds, event }: TimedCodexEvent): boolean {
    if (
      Predicate.isObjectOrArray(event) &&
      JSON.stringify(event).includes('"contextCompaction"')
    ) {
      this.invalidReason = "Context compacted before sufficient evidence.";

      return true;
    }

    if (milliseconds < this.previousMilliseconds) {
      this.invalidReason = "Non-monotonic event timestamps.";

      return true;
    }

    this.previousMilliseconds = milliseconds;

    if (Schema.is(submissionSchema)(event)) {
      if (
        this.taskSubmittedMilliseconds !== null ||
        this.firstRequestMilliseconds !== null
      ) {
        this.invalidReason =
          "Task submission must precede retrieval and occur once.";

        return true;
      }

      this.submittedThread = event.params.threadId;
      this.taskSubmittedMilliseconds = milliseconds;

      return false;
    }

    if (Schema.is(executionSchema)(event)) {
      this.commandMilliseconds += event.params.item.durationMs;
      this.measuredCommands += 1;
    }

    if (!Schema.is(rawItemSchema)(event)) {
      return false;
    }

    return this.observeRawItem(event, milliseconds);
  }
  observeRawItem(
    event: typeof rawItemSchema.Type,
    milliseconds: number
  ): boolean {
    if (
      this.submittedThread !== undefined &&
      this.submittedThread !== event.params.threadId
    ) {
      this.invalidReason =
        "Task submission and evidence belong to different threads.";

      return true;
    }

    const currentIdentity = JSON.stringify([
      event.params.threadId,
      event.params.turnId,
    ]);

    this.identity ??= currentIdentity;

    if (this.identity !== currentIdentity) {
      this.invalidReason = "Mixed thread or turn identities.";

      return true;
    }

    const { item } = event.params;

    if (Schema.is(callSchema)(item)) {
      if (
        this.started.has(item.call_id) ||
        this.nonRetrieval.has(item.call_id)
      ) {
        this.invalidReason = "Duplicate tool request.";

        return true;
      }

      if (
        ["update_plan", "request_user_input"].includes(
          requireDefined(item.name.split(".").at(-1))
        )
      ) {
        this.nonRetrieval.add(item.call_id);

        return false;
      }

      this.firstRequestMilliseconds ??= milliseconds;
      this.started.set(item.call_id, milliseconds);
    }

    if (!Schema.is(outputSchema)(item)) {
      if (
        Predicate.isObjectOrArray(item) &&
        "type" in item &&
        ["function_call_output", "custom_tool_call_output"].includes(
          String(item["type"])
        )
      ) {
        this.invalidReason = "Unsupported tool response content.";

        return true;
      }

      return false;
    }

    if (this.nonRetrieval.has(item.call_id)) {
      return false;
    }

    return this.observeOutput(item, milliseconds);
  }
  observeOutput(item: typeof outputSchema.Type, milliseconds: number): boolean {
    const start = this.started.get(item.call_id);

    if (start === undefined || this.completed.has(item.call_id)) {
      this.invalidReason = "Tool response has no unique request.";

      return true;
    }

    this.completed.add(item.call_id);

    const blocks = Predicate.isString(item.output)
      ? [item.output]
      : item.output.map(({ text }) => text);

    const returnedBytes = blocks.reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0
    );

    if (returnedBytes > 262_144) {
      this.invalidReason =
        "Tool response exceeds the verified history retention bound.";

      return true;
    }

    this.toolMilliseconds += milliseconds - start;
    this.evidenceTokens += blocks.reduce(
      (sum, text) => sum + countTokens(text, { disallowedSpecial: new Set() }),
      0
    );
    this.evidenceBytes += returnedBytes;
    const { complete, newFacts } = this.evidence.observe(blocks);

    if (newFacts.length > 0) {
      this.evidenceEvents.push({
        callId: item.call_id,
        facts: newFacts,
        milliseconds,
      });
    }

    if (complete) {
      this.sufficientEvidenceMilliseconds = milliseconds;

      return true;
    }

    return false;
  }
  result() {
    const readStatusResult = () => {
      if (this.invalidReason === null) {
        if (this.sufficientEvidenceMilliseconds === null) {
          return "insufficient";
        }

        return "complete";
      }

      return "invalid";
    };

    const statusResult = readStatusResult();
    const evidence = this.evidence.result();

    return {
      acquisitionModelUsage: null,
      evidenceBytes: this.evidenceBytes,
      evidenceEvents: this.evidenceEvents,
      evidenceTokens: this.evidenceTokens,
      firstRequestMilliseconds: this.firstRequestMilliseconds,
      invalidReason: this.invalidReason,
      matchedFacts: evidence.matchedFacts,
      measuredCommands: this.measuredCommands,
      missingExportIndexParts: evidence.missingExportIndexParts,
      missingFacts: evidence.missingFacts,
      retrievalCalls: this.started.size,
      retrievalSeconds:
        this.firstRequestMilliseconds === null ||
        this.sufficientEvidenceMilliseconds === null
          ? null
          : (this.sufficientEvidenceMilliseconds -
              this.firstRequestMilliseconds) /
            1000,
      status: statusResult,
      sufficientEvidenceMilliseconds: this.sufficientEvidenceMilliseconds,
      taskSubmittedMilliseconds: this.taskSubmittedMilliseconds,
      taskToEvidenceSeconds:
        this.taskSubmittedMilliseconds === null ||
        this.sufficientEvidenceMilliseconds === null
          ? null
          : (this.sufficientEvidenceMilliseconds -
              this.taskSubmittedMilliseconds) /
            1000,
      tokenization: {
        encoding: "o200k_base",
        package: "gpt-tokenizer",
        version: "4.1.0",
      },
      toolExecutionSeconds:
        this.measuredCommands === 0 ? null : this.commandMilliseconds / 1000,
      toolRoundTripSeconds: this.toolMilliseconds / 1000,
    };
  }
}

export const measureAcquisition = function measureAcquisition(
  oracle: AcquisitionOracle,
  events: readonly TimedCodexEvent[]
) {
  const measurement = new AcquisitionMeasurement(oracle);

  for (const event of events) {
    if (measurement.observe(event)) {
      break;
    }
  }

  return measurement.result();
};
