import { Predicate, Schema } from "effect";

import { decodeJson } from "#typepeek/shared/json-data";

const TURN_COMPLETED = "turn.completed";

const tokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const usageSchema = Schema.Struct({
  cached_input_tokens: Schema.optional(tokenCount),
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  reasoning_output_tokens: Schema.optional(tokenCount),
});

const completedTurnSchema = Schema.Struct({
  type: Schema.Literal(TURN_COMPLETED),
  usage: usageSchema,
});

const commandSchema = Schema.Struct({
  item: Schema.Struct({
    aggregated_output: Schema.optional(Schema.String),
    command: Schema.String,
    exit_code: Schema.optional(Schema.Int),
    type: Schema.Literal("command_execution"),
  }),
  type: Schema.Literal("item.completed"),
});

const serverResponseSchema = Schema.Struct({
  method: Schema.Literal("rawResponse/completed"),
  params: Schema.Struct({
    usage: Schema.Struct({
      cachedInputTokens: tokenCount,
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      reasoningOutputTokens: tokenCount,
    }),
  }),
});

const serverTurnSchema = Schema.Struct({
  method: Schema.Literal("turn/completed"),
  params: Schema.Struct({ turn: Schema.Struct({ status: Schema.String }) }),
});

const serverCommandSchema = Schema.Struct({
  method: Schema.Literal("item/completed"),
  params: Schema.Struct({
    item: Schema.Struct({
      aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
      command: Schema.String,
      exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
      type: Schema.Literal("commandExecution"),
    }),
  }),
});

const usesTypepeek = function usesTypepeek(command: string): boolean {
  return /(?:^|[\s/"'])typepeek(?:[\s"']|$)/u.test(command);
};

const atomicEvidenceSchema = Schema.Struct({
  intent: Schema.String,
  moduleExport: Schema.optional(Schema.Struct({ name: Schema.String })),
  query: Schema.optional(Schema.String),
  specifier: Schema.String,
});

const inspectionEvidenceSchema = Schema.Struct({
  result: Schema.Union([
    atomicEvidenceSchema,
    Schema.Struct({
      inspections: Schema.Array(atomicEvidenceSchema),
      intent: Schema.Literal("inspection-plan"),
    }),
  ]),
  status: Schema.Literal("success"),
});

const readTypepeekEvidence = function readTypepeekEvidence(output: string) {
  const evidence: {
    intent: string;
    specifier: string;
    exportName?: string;
    query?: string;
  }[] = [];

  for (const text of new Set(
    [output, ...output.split("\n")].map((lineText) => lineText.trim())
  )) {
    try {
      const value = decodeJson(Schema.MutableJson, text);

      if (!Schema.is(inspectionEvidenceSchema)(value)) {
        continue;
      }

      const results =
        "inspections" in value.result
          ? value.result.inspections
          : [value.result];

      for (const { intent, specifier, moduleExport, query } of results) {
        evidence.push({
          intent,
          specifier,
          ...(query !== undefined && { query }),
          ...(moduleExport !== undefined && { exportName: moduleExport.name }),
        });
      }
    } catch {
      // Tool output may also contain ordinary text.
    }
  }

  return evidence;
};

const isIncompleteTurn = (value: Schema.MutableJson): boolean => {
  if (!Predicate.isReadonlyObject(value) || !("type" in value)) {
    return false;
  }

  const { type } = value;

  if (type === "turn.failed" || type === "error") {
    return true;
  }

  return type === TURN_COMPLETED && !Schema.is(completedTurnSchema)(value);
};

class CodexTelemetryAccumulator {
  inputTokens = 0;
  outputTokens = 0;
  cachedInputTokens = 0;
  cachedUsageComplete = true;
  reasoningUsageComplete = true;
  reasoningOutputTokens: number | null = null;
  completedTurns = 0;
  incompleteUsage = false;
  commands: string[] = [];
  toolOutputBytes = 0;
  typepeekEvidence: {
    intent: string;
    specifier: string;
    exportName?: string;
    query?: string;
  }[] = [];
  invalidLines = 0;
  serverResponses = 0;
  knownServerResponses = 0;
  serverTotals = { cached: 0, input: 0, output: 0, reasoning: 0 };
  serverUsage = {
    cached_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  observeLine(line: string): void {
    let value: Schema.MutableJson;

    try {
      value = decodeJson(Schema.MutableJson, line);
    } catch {
      this.invalidLines += 1;

      return;
    }

    this.observeServerResponse(value);
    value = this.normalizeServerEvent(value);
    this.observeTurn(value);
    this.observeCommand(value);
  }
  observeServerResponse(value: Schema.MutableJson): void {
    if (Schema.is(serverResponseSchema)(value)) {
      const { usage } = value.params;
      this.serverUsage.input_tokens += usage.inputTokens;
      this.serverUsage.output_tokens += usage.outputTokens;
      this.serverUsage.cached_input_tokens += usage.cachedInputTokens;
      this.serverUsage.reasoning_output_tokens += usage.reasoningOutputTokens;
      this.serverResponses += 1;
      this.knownServerResponses += 1;
      this.serverTotals.input += usage.inputTokens;
      this.serverTotals.output += usage.outputTokens;
      this.serverTotals.cached += usage.cachedInputTokens;
      this.serverTotals.reasoning += usage.reasoningOutputTokens;
    } else if (
      Predicate.isObjectOrArray(value) &&
      "method" in value &&
      value["method"] === "rawResponse/completed"
    ) {
      this.incompleteUsage = true;
    }
  }
  normalizeServerEvent(event: Schema.MutableJson): Schema.MutableJson {
    let value = event;

    if (Schema.is(serverTurnSchema)(value)) {
      if (this.serverResponses === 0) {
        this.incompleteUsage = true;
      }

      value =
        value.params.turn.status === "completed"
          ? { type: TURN_COMPLETED, usage: { ...this.serverUsage } }
          : { type: "turn.failed" };
      this.serverResponses = 0;
      Object.assign(this.serverUsage, {
        cached_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      });
    }

    if (Schema.is(serverCommandSchema)(value)) {
      const { item } = value.params;
      value = {
        item: {
          command: item.command,
          type: "command_execution",
          ...(Predicate.isNotNullish(item.aggregatedOutput) && {
            aggregated_output: item.aggregatedOutput,
          }),
          ...(Predicate.isNotNullish(item.exitCode) && {
            exit_code: item.exitCode,
          }),
        },
        type: "item.completed",
      };
    }

    return value;
  }
  observeTurn(value: Schema.MutableJson): void {
    if (isIncompleteTurn(value)) {
      this.incompleteUsage = true;
    }

    if (Schema.is(completedTurnSchema)(value)) {
      this.completedTurns += 1;
      this.inputTokens += value.usage.input_tokens;
      this.outputTokens += value.usage.output_tokens;
      this.cachedInputTokens += value.usage.cached_input_tokens ?? 0;

      if (value.usage.cached_input_tokens === undefined) {
        this.cachedUsageComplete = false;
      }

      if (value.usage.reasoning_output_tokens === undefined) {
        this.reasoningUsageComplete = false;
      }

      if (value.usage.reasoning_output_tokens !== undefined) {
        this.reasoningOutputTokens =
          (this.reasoningOutputTokens ?? 0) +
          value.usage.reasoning_output_tokens;
      }
    }
  }
  observeCommand(value: Schema.MutableJson): void {
    if (Schema.is(commandSchema)(value)) {
      this.commands.push(value.item.command);

      if (usesTypepeek(value.item.command) && value.item.exit_code === 0) {
        this.typepeekEvidence.push(
          ...readTypepeekEvidence(value.item.aggregated_output ?? "")
        );
      }

      this.toolOutputBytes += Buffer.byteLength(
        value.item.aggregated_output ?? ""
      );
    }
  }
  result() {
    const readReasoningOutputTokensResult = () => {
      if (this.knownServerResponses > 0) {
        return this.serverTotals.reasoning;
      }

      if (this.reasoningUsageComplete) {
        return this.reasoningOutputTokens;
      }

      return null;
    };

    const reasoningOutputTokensResult = readReasoningOutputTokensResult();

    const readOutputTokensResult = () => {
      if (this.knownServerResponses > 0) {
        return this.serverTotals.output;
      }

      if (this.completedTurns === 0) {
        return null;
      }

      return this.outputTokens;
    };

    const outputTokensResult = readOutputTokensResult();

    const readInputTokensResult = () => {
      if (this.knownServerResponses > 0) {
        return this.serverTotals.input;
      }

      if (this.completedTurns === 0) {
        return null;
      }

      return this.inputTokens;
    };

    const inputTokensResult = readInputTokensResult();

    const readCachedInputTokensResult = () => {
      if (this.knownServerResponses > 0) {
        return this.serverTotals.cached;
      }

      if (this.completedTurns === 0 || !this.cachedUsageComplete) {
        return null;
      }

      return this.cachedInputTokens;
    };

    const cachedInputTokensResult = readCachedInputTokensResult();

    return {
      cachedInputTokens: cachedInputTokensResult,
      commands: this.commands,
      completedTurns: this.completedTurns,
      inputTokens: inputTokensResult,
      invalidLines: this.invalidLines,
      outputTokens: outputTokensResult,
      reasoningOutputTokens: reasoningOutputTokensResult,
      toolOutputBytes: this.toolOutputBytes,
      typepeekEvidence: this.typepeekEvidence,
      usageComplete:
        this.completedTurns > 0 &&
        !this.incompleteUsage &&
        this.invalidLines === 0,
      usedTypepeek: this.commands.some(usesTypepeek),
    };
  }
}

export const codexTelemetry = function codexTelemetry(events: string) {
  const telemetry = new CodexTelemetryAccumulator();

  for (const line of events.split("\n").filter(Boolean)) {
    telemetry.observeLine(line);
  }

  return telemetry.result();
};
