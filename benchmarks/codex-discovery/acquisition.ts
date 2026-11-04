import { Predicate, Schema } from "effect";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";

import { typepeekFacts } from "../support/evidence.ts";
import { signatureFact } from "../support/signature.ts";

const millisecondsSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0)
);

const oracleSchema = Schema.Struct({
  declarations: Schema.Array(
    Schema.Struct({ fact: Schema.String, text: Schema.String })
  ),
  exportDeclarations: Schema.Array(Schema.String),
  facts: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(1),
  workload: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["signatures", "search"]),
    specifier: Schema.String,
    target: Schema.String,
  }),
});

export type AcquisitionOracle = typeof oracleSchema.Type;

export const decodeAcquisitionOracle = Schema.decodeUnknownSync(oracleSchema);

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

const commandResultSchema = Schema.Struct({
  chunk_id: Schema.String,
  exit_code: Schema.Literal(0),
  output: Schema.String,
  wall_time_seconds: millisecondsSchema,
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

const jsonObjects = function* jsonObjects(text: string): Generator<string> {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
    } else if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        yield text.slice(start, index + 1);
        start = -1;
      }
    }
  }
};

const commandOutputText = function commandOutputText(text: string): string[] {
  const decoded: string[] = [text];

  for (const candidate of jsonObjects(text)) {
    try {
      const value = decodeJson(Schema.MutableJson, candidate);

      if (Schema.is(commandResultSchema)(value)) {
        decoded.push(value.output);
      }
    } catch {
      continue;
    }
  }

  return decoded;
};

const sourceFragments = function sourceFragments(text: string): string[] {
  const fragments: string[] = [];
  let previousFile: string | null = null;
  let previousLine: number | null = null;

  for (const line of text.split("\n")) {
    const match =
      /^(?:(?<file>.*?\.(?:[cm]?[jt]s|[jt]sx))[:-])?(?<line>\d+)[:-](?<body>.*)$/u.exec(
        line
      );

    if (match === null) {
      if (previousLine === null && fragments.length > 0) {
        fragments[fragments.length - 1] += `\n${line}`;
      } else {
        fragments.push(line);
      }

      previousFile = null;
      previousLine = null;
      continue;
    }

    const {
      file: matchedFile,
      line: number,
      body,
    } = requireDefined(match.groups);

    const file = matchedFile ?? null;
    const lineNumber = Number(number);

    if (
      file === previousFile &&
      previousLine !== null &&
      lineNumber === previousLine + 1
    ) {
      fragments[fragments.length - 1] += `\n${body}`;
    } else {
      fragments.push(requireDefined(body));
    }

    previousFile = file ?? null;
    previousLine = lineNumber;
  }

  return fragments;
};

class AcquisitionMeasurement {
  started = new Map<string, number>();
  nonRetrieval = new Set<string>();
  sourceBodies: string[] = [];
  matched = new Set<string>();
  completed = new Set<string>();
  indexes = new Set<string>();
  completeSearch = false;
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
  readonly oracle: AcquisitionOracle;
  constructor(oracle: AcquisitionOracle) {
    this.oracle = oracle;
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

    const returnedText = blocks.flatMap(commandOutputText).join("\n");

    const returnedBytes = blocks.reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0
    );

    if (returnedBytes > 262_144) {
      this.invalidReason =
        "Tool response exceeds the verified history retention bound.";

      return true;
    }

    const before = new Set(this.matched);
    this.toolMilliseconds += milliseconds - start;
    this.evidenceTokens += blocks.reduce(
      (sum, text) => sum + countTokens(text, { disallowedSpecial: new Set() }),
      0
    );
    this.evidenceBytes += returnedBytes;
    this.observeEvidence(returnedText);
    const newFacts = [...this.matched].filter((fact) => !before.has(fact));

    if (newFacts.length > 0) {
      this.evidenceEvents.push({
        callId: item.call_id,
        facts: newFacts,
        milliseconds,
      });
    }

    if (
      this.oracle.workload.kind === "search"
        ? this.completeSearch
        : this.oracle.facts.length > 0 &&
          this.oracle.facts.every((fact) => this.matched.has(fact))
    ) {
      this.sufficientEvidenceMilliseconds = milliseconds;

      return true;
    }

    return false;
  }
  observeStructuredEvidence(returnedText: string): void {
    for (const candidate of jsonObjects(returnedText)) {
      try {
        const facts = typepeekFacts(
          { ...this.oracle.workload, question: "" },
          candidate
        );

        if (
          this.oracle.workload.kind === "search" &&
          JSON.stringify(facts) === JSON.stringify(this.oracle.facts)
        ) {
          this.completeSearch = true;
        }

        if (facts.every((fact) => this.oracle.facts.includes(fact))) {
          for (const fact of facts) {
            this.matched.add(fact);
          }
        }
      } catch {
        continue;
      }
    }
  }
  observeEvidence(returnedText: string): void {
    this.observeStructuredEvidence(returnedText);

    const numbered = returnedText.replaceAll(
      /^(?:Script completed|Wall time[^\n]*|Chunk ID:[^\n]*|Process exited[^\n]*|(?:Final )?[Oo]utput:)[\r\n]*/gmu,
      ""
    );

    this.sourceBodies.push(numbered.trim());

    const outputs = [
      ...sourceFragments(numbered),
      ...sourceFragments(this.sourceBodies.join("\n")),
    ].map((text) =>
      signatureFact("declaration", text).slice("declaration:".length)
    );

    const contains = (text: string) =>
      outputs.some((body) => ` ${body} `.includes(` ${text} `));

    for (const declaration of this.oracle.declarations) {
      const text = signatureFact("declaration", declaration.text).slice(
        "declaration:".length
      );

      if (contains(text)) {
        this.matched.add(declaration.fact);
      }
    }

    for (const declaration of this.oracle.exportDeclarations) {
      const text = signatureFact("declaration", declaration).slice(
        "declaration:".length
      );

      if (contains(text)) {
        this.indexes.add(declaration);
      }
    }

    if (
      this.oracle.workload.kind === "search" &&
      this.oracle.exportDeclarations.length > 0 &&
      this.oracle.exportDeclarations.every((declaration) =>
        this.indexes.has(declaration)
      )
    ) {
      this.completeSearch = true;

      for (const fact of this.oracle.facts) {
        this.matched.add(fact);
      }
    }
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

    return {
      acquisitionModelUsage: null,
      evidenceBytes: this.evidenceBytes,
      evidenceEvents: this.evidenceEvents,
      evidenceTokens: this.evidenceTokens,
      firstRequestMilliseconds: this.firstRequestMilliseconds,
      invalidReason: this.invalidReason,
      matchedFacts: this.oracle.facts.filter((fact) => this.matched.has(fact)),
      measuredCommands: this.measuredCommands,
      missingExportIndexParts: this.completeSearch
        ? 0
        : this.oracle.exportDeclarations.filter(
            (declaration) => !this.indexes.has(declaration)
          ).length,
      missingFacts: this.oracle.facts.filter((fact) => !this.matched.has(fact)),
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
