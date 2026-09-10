import { Schema } from "effect";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

import { typepeekFacts } from "../discovery/evidence.ts";
import { signatureFact } from "../discovery/signature.ts";

const millisecondsSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const oracleSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workload: Schema.Struct({
    id: Schema.String,
    specifier: Schema.String,
    kind: Schema.Literals(["signatures", "search"]),
    target: Schema.String,
  }),
  facts: Schema.Array(Schema.String),
  declarations: Schema.Array(Schema.Struct({ fact: Schema.String, text: Schema.String })),
  exportDeclarations: Schema.Array(Schema.String),
});
export type AcquisitionOracle = typeof oracleSchema.Type;
export const decodeAcquisitionOracle = Schema.decodeUnknownSync(oracleSchema);

const observationSchema = Schema.Struct({
  milliseconds: millisecondsSchema,
  event: Schema.Unknown,
});
export type TimedCodexEvent = typeof observationSchema.Type;

const rawItemSchema = Schema.Struct({
  method: Schema.Literal("rawResponseItem/completed"),
  params: Schema.Struct({ item: Schema.Unknown, threadId: Schema.String, turnId: Schema.String }),
});
const callSchema = Schema.Struct({
  type: Schema.Literals(["function_call", "custom_tool_call"]),
  call_id: Schema.String,
  name: Schema.String,
});
const outputSchema = Schema.Struct({
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
  call_id: Schema.String,
  output: Schema.Union([
    Schema.String,
    Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
  ]),
});
const executionSchema = Schema.Struct({
  method: Schema.Literal("item/completed"),
  params: Schema.Struct({
    item: Schema.Struct({
      type: Schema.Literal("commandExecution"),
      durationMs: millisecondsSchema,
    }),
  }),
});

export function decodeTimedCodexEvents(serialized: string): readonly TimedCodexEvent[] {
  return serialized
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(observationSchema)(JSON.parse(line)));
}

export function measureAcquisition(oracle: AcquisitionOracle, events: readonly TimedCodexEvent[]) {
  const started = new Map<string, number>();
  const nonRetrieval = new Set<string>();
  const sourceBodies: string[] = [];
  const matched = new Set<string>();
  const completed = new Set<string>();
  const indexes = new Set<string>();
  let completeSearch = false;
  const evidenceEvents: { callId: string; milliseconds: number; facts: string[] }[] = [];
  let invalidReason: string | null = null;
  let previousMilliseconds = 0;
  let identity: string | undefined;
  let firstRequestMilliseconds: number | null = null;
  let sufficientEvidenceMilliseconds: number | null = null;
  let toolMilliseconds = 0;
  let commandMilliseconds = 0;
  let measuredCommands = 0;
  let evidenceTokens = 0;
  let evidenceBytes = 0;
  for (const { milliseconds, event } of events) {
    if (
      typeof event === "object" &&
      event !== null &&
      JSON.stringify(event).includes('"contextCompaction"')
    ) {
      invalidReason = "Context compacted before sufficient evidence.";
      break;
    }
    if (milliseconds < previousMilliseconds) {
      invalidReason = "Non-monotonic event timestamps.";
      break;
    }
    previousMilliseconds = milliseconds;
    if (Schema.is(executionSchema)(event)) {
      commandMilliseconds += event.params.item.durationMs;
      measuredCommands += 1;
    }
    if (!Schema.is(rawItemSchema)(event)) continue;
    const currentIdentity = JSON.stringify([event.params.threadId, event.params.turnId]);
    identity ??= currentIdentity;
    if (identity !== currentIdentity) {
      invalidReason = "Mixed thread or turn identities.";
      break;
    }
    const { item } = event.params;
    if (Schema.is(callSchema)(item)) {
      if (started.has(item.call_id) || nonRetrieval.has(item.call_id)) {
        invalidReason = "Duplicate tool request.";
        break;
      }
      if (["update_plan", "request_user_input"].includes(item.name.split(".").at(-1)!)) {
        nonRetrieval.add(item.call_id);
        continue;
      }
      firstRequestMilliseconds ??= milliseconds;
      started.set(item.call_id, milliseconds);
    }
    if (!Schema.is(outputSchema)(item)) {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        ["function_call_output", "custom_tool_call_output"].includes(String(item.type))
      ) {
        invalidReason = "Unsupported tool response content.";
        break;
      }
      continue;
    }
    if (nonRetrieval.has(item.call_id)) continue;
    const start = started.get(item.call_id);
    if (start === undefined || completed.has(item.call_id)) {
      invalidReason = "Tool response has no unique request.";
      break;
    }
    completed.add(item.call_id);
    const blocks =
      typeof item.output === "string" ? [item.output] : item.output.map(({ text }) => text);
    const returnedText = blocks.join("\n");
    const returnedBytes = blocks.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (returnedBytes > 262144) {
      invalidReason = "Tool response exceeds the verified history retention bound.";
      break;
    }
    const before = new Set(matched);
    toolMilliseconds += milliseconds - start;
    evidenceTokens += blocks.reduce(
      (sum, text) => sum + countTokens(text, { disallowedSpecial: new Set() }),
      0,
    );
    evidenceBytes += returnedBytes;
    for (const candidate of jsonObjects(returnedText)) {
      try {
        const facts = typepeekFacts({ ...oracle.workload, question: "" }, candidate);
        if (
          oracle.workload.kind === "search" &&
          JSON.stringify(facts) === JSON.stringify(oracle.facts)
        )
          completeSearch = true;
        if (facts.every((fact) => oracle.facts.includes(fact))) {
          for (const fact of facts) matched.add(fact);
        }
      } catch {
        continue;
      }
    }
    const numbered = returnedText
      .replace(
        /^(?:Script completed|Wall time[^\n]*|Chunk ID:[^\n]*|Process exited[^\n]*|(?:Final )?[Oo]utput:|```(?:typescript|ts)?)[\r\n]*/gmu,
        "",
      )
      .replace(/^(?:[^\n]*?\.(?:[cm]?ts|tsx)[:-])?\d+[:-]/gmu, "");
    sourceBodies.push(numbered);
    const output = signatureFact("declaration", numbered).slice("declaration:".length);
    const accumulated = signatureFact("declaration", sourceBodies.join("\n")).slice(
      "declaration:".length,
    );
    const contains = (text: string) =>
      [output, accumulated].some((body) => ` ${body} `.includes(` ${text} `));
    for (const declaration of oracle.declarations) {
      const text = signatureFact("declaration", declaration.text).slice("declaration:".length);
      if (contains(text)) matched.add(declaration.fact);
    }
    for (const declaration of oracle.exportDeclarations) {
      const text = signatureFact("declaration", declaration).slice("declaration:".length);
      if (contains(text)) indexes.add(declaration);
    }
    if (
      oracle.workload.kind === "search" &&
      oracle.exportDeclarations.length > 0 &&
      oracle.exportDeclarations.every((declaration) => indexes.has(declaration))
    ) {
      completeSearch = true;
      for (const fact of oracle.facts) matched.add(fact);
    }
    const newFacts = [...matched].filter((fact) => !before.has(fact));
    if (newFacts.length > 0)
      evidenceEvents.push({ callId: item.call_id, milliseconds, facts: newFacts });
    if (
      oracle.workload.kind === "search"
        ? completeSearch
        : oracle.facts.length > 0 && oracle.facts.every((fact) => matched.has(fact))
    ) {
      sufficientEvidenceMilliseconds = milliseconds;
      break;
    }
  }
  return {
    status:
      invalidReason !== null
        ? "invalid"
        : sufficientEvidenceMilliseconds === null
          ? "insufficient"
          : "complete",
    invalidReason,
    firstRequestMilliseconds,
    sufficientEvidenceMilliseconds,
    retrievalSeconds:
      firstRequestMilliseconds === null || sufficientEvidenceMilliseconds === null
        ? null
        : (sufficientEvidenceMilliseconds - firstRequestMilliseconds) / 1000,
    toolRoundTripSeconds: toolMilliseconds / 1000,
    toolExecutionSeconds: measuredCommands === 0 ? null : commandMilliseconds / 1000,
    measuredCommands,
    retrievalCalls: started.size,
    evidenceTokens,
    evidenceBytes,
    tokenization: { encoding: "o200k_base", package: "gpt-tokenizer", version: "4.0.0" },
    acquisitionModelUsage: null,
    matchedFacts: oracle.facts.filter((fact) => matched.has(fact)),
    missingFacts: oracle.facts.filter((fact) => !matched.has(fact)),
    missingExportIndexParts: completeSearch
      ? 0
      : oracle.exportDeclarations.filter((declaration) => !indexes.has(declaration)).length,
    evidenceEvents,
  };
}

function* jsonObjects(text: string): Generator<string> {
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
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        yield text.slice(start, index + 1);
        start = -1;
      }
    }
  }
}
