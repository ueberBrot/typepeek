import { execa } from "execa";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

import {
  codexPrompt,
  codexTelemetry,
  gradeCodexAnswer,
  gradeCodexExecution,
  selectCodexScenarios,
} from "../benchmarks/codex-discovery/scenarios.ts";
import { signatureFact } from "../benchmarks/support/signature.ts";

it("previews the eight-runner matrix reproducibly without creating trial artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-schedule-"));
  try {
    const args = [
      "benchmarks/codex-discovery/run.ts",
      "--dry-run",
      "--output",
      join(directory, "unused"),
    ];
    const first = await execa(process.execPath, args);
    const second = await execa(process.execPath, args);
    expect(second.stdout).toBe(first.stdout);
    const plan = JSON.parse(first.stdout) as {
      trials: { model: string; effort: string; condition: string }[];
    };
    expect(plan.trials).toHaveLength(240);
    expect([...new Set(plan.trials.map(({ condition }) => condition))].sort()).toEqual([
      "files",
      "typepeek-skill",
    ]);
    expect(
      [...new Set(plan.trials.map(({ model, effort }) => `${model}/${effort}`))].sort(),
    ).toEqual([
      "gpt-5.6-luna/high",
      "gpt-5.6-luna/low",
      "gpt-5.6-sol/high",
      "gpt-5.6-sol/low",
      "gpt-5.6-terra/high",
      "gpt-5.6-terra/low",
      "gpt-6-astra/high",
      "gpt-6-astra/low",
    ]);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a matrix that combines all workloads with individual workloads", async () => {
  const result = await execa(
    process.execPath,
    ["benchmarks/codex-discovery/run.ts", "--dry-run", "--cases", "all,execa-command"],
    { reject: false },
  );
  expect(result.failed).toBe(true);
  expect(result.stderr).toContain("all must be used alone");
});

it("records unavailable ripgrep without blocking benchmark setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-no-search-tool-"));
  try {
    await mkdir(join(directory, "dist"));
    await mkdir(join(directory, "benchmarks", "support"), { recursive: true });
    await writeFile(join(directory, "package.json"), "{}");
    await writeFile(join(directory, "pnpm-lock.yaml"), "");
    const result = await execa(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { discoveryIdentity } from ${JSON.stringify(new URL("../benchmarks/support/identity.ts", import.meta.url).href)};
      const identity = await discoveryIdentity({
        workspace: process.cwd(), compilerVersion: 'test', evidenceHash: 'test',
      });
      console.log(identity.ripgrep);
    `,
      ],
      { cwd: directory, env: { PATH: directory } },
    );
    expect(result.stdout).toBe("unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("ignores an optional trailing comma in destructured parameters without changing fields", () => {
  expect(signatureFact("call", "({ routes, aliases, }: Routes): Result")).toBe(
    signatureFact("call", "({ routes, aliases }: Routes): Result"),
  );
  expect(signatureFact("call", "({ routes }: Routes): Result")).not.toBe(
    signatureFact("call", "({ routes, aliases }: Routes): Result"),
  );
});

it.each(["execa-command", "node-exists", "effect-option", "stricli-routes", "typescript-program"])(
  "keeps the %s discovery answer out of every condition's prompt",
  (id) => {
    const scenario = selectCodexScenarios([id])[0]!;
    expect(scenario.discovery).toBe(true);
    for (const condition of ["files", "typepeek", "typepeek-skill", "typepeek-required"] as const) {
      const prompt = codexPrompt(scenario, condition, "SKILL CONTENT");
      expect(prompt).not.toContain(scenario.workload.target);
      expect(prompt).toContain(`Question: ${scenario.question}`);
      expect(prompt).not.toContain("rg ");
    }
  },
);

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
  const skillPrompt = codexPrompt(scenario, "typepeek-skill", "SKILL CONTENT");
  expect(skillPrompt).toContain("Use $typepeek");
  expect(skillPrompt).toContain("SKILL CONTENT");
  expect(treatment).not.toContain("$typepeek");
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

it("marks partial or damaged usage logs incomplete while retaining known token counts", () => {
  const complete = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  expect(codexTelemetry(complete).usageComplete).toBe(true);
  for (const trailing of [
    '{"type":"turn.completed","usage":{}}',
    '{"type":"turn.failed"}',
    "not-json",
  ]) {
    expect(codexTelemetry(`${complete}\n${trailing}`)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      usageComplete: false,
    });
  }
  expect(codexTelemetry("").usageComplete).toBe(false);
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
  expect(command(`${evidence}\n`).typepeekEvidence).toHaveLength(1);
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
