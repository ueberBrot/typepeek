import { expect, it } from "vite-plus/test";

import {
  codexPrompt,
  codexTelemetry,
  gradeCodexAnswer,
  gradeCodexExecution,
  selectCodexScenarios,
} from "../benchmarks/codex-discovery/scenarios.ts";
import { signatureFact } from "../benchmarks/discovery/signature.ts";

it("ignores an optional trailing comma in destructured parameters without changing fields", () => {
  expect(signatureFact("call", "({ routes, aliases, }: Routes): Result")).toBe(
    signatureFact("call", "({ routes, aliases }: Routes): Result"),
  );
  expect(signatureFact("call", "({ routes }: Routes): Result")).not.toBe(
    signatureFact("call", "({ routes, aliases }: Routes): Result"),
  );
});

it("lets both Codex conditions choose their strategy without giving away discovery answers", () => {
  const scenario = selectCodexScenarios(["execa-command"])[0]!;
  const baseline = codexPrompt(scenario, "files", "");
  const treatment = codexPrompt(scenario, "typepeek", "");
  for (const prompt of [baseline, treatment]) {
    expect(prompt).toContain("Choose the fastest reliable local inspection strategy yourself");
    expect(prompt).not.toContain("parseCommandString");
    expect(prompt).not.toContain("types/methods/command.d.ts");
  }
  expect(baseline).toContain("Typepeek is unavailable");
  expect(treatment).toContain("you are not required to call it");
  expect(codexPrompt(scenario, "typepeek-skill", "SKILL CONTENT")).toContain("SKILL CONTENT");
});

it("counts complete Codex usage while retaining cached and reasoning breakdowns", () => {
  const events = [
    { type: "item.started", item: { type: "command_execution", command: "typepeek --help" } },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "typepeek signatures execa parseCommandString --json",
        aggregated_output: "abc",
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        output_tokens: 20,
        reasoning_output_tokens: 10,
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 50,
        cached_input_tokens: 20,
        output_tokens: 15,
        reasoning_output_tokens: 5,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  expect(codexTelemetry(events)).toMatchObject({
    completedTurns: 2,
    inputTokens: 150,
    cachedInputTokens: 80,
    outputTokens: 35,
    reasoningOutputTokens: 15,
    toolOutputBytes: 3,
    usedTypepeek: true,
    invalidLines: 0,
  });
  expect(codexTelemetry(events).commands).toHaveLength(1);
  expect(codexTelemetry('{"type":"turn.failed"}')).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  });
});

it("accepts a verified discovered export and rejects invented or incomplete signatures", () => {
  const scenario = selectCodexScenarios(["execa-command"])[0]!;
  const expected = ["call:( command : string ) : string [ ]"];
  const answer = {
    status: "answered",
    specifier: "execa",
    exportName: "parseCommandString",
    signatures: ["(command:string):string[]"],
    matches: [],
  };
  expect(gradeCodexAnswer(scenario, expected, JSON.stringify(answer)).passed).toBe(true);
  expect(
    gradeCodexAnswer(
      scenario,
      expected,
      JSON.stringify({ ...answer, signatures: ["(command: string): {}"] }),
    ).passed,
  ).toBe(false);
  expect(
    gradeCodexAnswer(scenario, expected, JSON.stringify({ ...answer, signatures: [] })).passed,
  ).toBe(false);
  expect(
    gradeCodexAnswer(scenario, expected, JSON.stringify({ ...answer, exportName: "invented" }))
      .passed,
  ).toBe(false);
  expect(gradeCodexAnswer(scenario, expected, "not JSON").passed).toBe(false);
});

it("requires task evidence in the required-use condition and keeps availability optional", () => {
  const scenario = selectCodexScenarios(["execa-command"])[0]!;
  const completion = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const command = (output: string, exitCode = 0) =>
    codexTelemetry(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "typepeek signatures execa parseCommandString --json",
            aggregated_output: output,
            exit_code: exitCode,
          },
        }),
        completion,
      ].join("\n"),
    );
  const evidence = JSON.stringify({
    status: "success",
    result: {
      intent: "signature-inspection",
      specifier: "execa",
      moduleExport: { name: "parseCommandString" },
    },
  });
  expect(gradeCodexExecution(scenario, "typepeek-required", codexTelemetry(completion))).toContain(
    "No command",
  );
  expect(gradeCodexExecution(scenario, "typepeek-required", command("Usage: typepeek"))).toContain(
    "inspection",
  );
  expect(gradeCodexExecution(scenario, "typepeek-required", command(evidence, 1))).toContain(
    "inspection",
  );
  expect(
    gradeCodexExecution(scenario, "typepeek-required", command(evidence.replace("execa", "other"))),
  ).toContain("inspection");
  expect(gradeCodexExecution(scenario, "typepeek-required", command(evidence))).toBeNull();
  const plan = JSON.stringify({
    status: "success",
    result: { intent: "inspection-plan", inspections: [JSON.parse(evidence).result] },
  });
  expect(gradeCodexExecution(scenario, "typepeek-required", command(plan))).toBeNull();
  expect(gradeCodexExecution(scenario, "typepeek", command("Usage: typepeek"))).toBeNull();
  expect(gradeCodexExecution(scenario, "files", command(evidence))).toContain("Control");
  const prompt = codexPrompt(scenario, "typepeek-required", "SKILL CONTENT");
  expect(prompt).toContain("must inspect");
  expect(prompt).toContain("SKILL CONTENT");
  expect(prompt).not.toContain("you are not required");
  expect(prompt).not.toContain("parseCommandString");
});

it("requires the requested name search rather than an unrelated query in the same module", () => {
  const scenario = selectCodexScenarios(["execa-errors"])[0]!;
  const telemetry = (query: string) =>
    codexTelemetry(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: `typepeek search execa ${query} --json`,
            exit_code: 0,
            aggregated_output: JSON.stringify({
              status: "success",
              result: { intent: "export-search", specifier: "execa", query },
            }),
          },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
      ].join("\n"),
    );
  expect(gradeCodexExecution(scenario, "typepeek-required", telemetry("unrelated"))).toContain(
    "inspection",
  );
  expect(gradeCodexExecution(scenario, "typepeek-required", telemetry("ERROR"))).toBeNull();
});
