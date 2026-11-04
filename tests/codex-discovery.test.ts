import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { execa } from "execa";
import { describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";

import { readCodexOptions } from "../benchmarks/codex-discovery/options.ts";
import {
  codexPrompt,
  codexTelemetry,
  gradeCodexAnswer,
  gradeCodexExecution,
  selectCodexScenarios,
} from "../benchmarks/codex-discovery/scenarios.ts";
import { signatureFact } from "../benchmarks/support/signature.ts";
import { match } from "./helpers/matchers.ts";

const telemetry = (query: string) =>
  codexTelemetry(
    [
      JSON.stringify({
        item: {
          aggregated_output: JSON.stringify({
            result: { intent: "export-search", query, specifier: "execa" },
            status: "success",
          }),
          command: `typepeek search execa ${query} --json`,
          exit_code: 0,
          type: "command_execution",
        },
        type: "item.completed",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n")
  );

describe("codex-discovery", () => {
  it("allows an explicit unlimited campaign while retaining per-trial limits", () => {
    const original = process.argv;

    try {
      process.argv = [
        process.execPath,
        "benchmark",
        "--total-token-limit",
        "unlimited",
      ];
      const options = readCodexOptions();
      expect([
        options.totalTokenLimit === null,
        options.trialTokenLimit,
        options.deadlineSeconds,
      ]).toStrictEqual([true, 60_000, 120]);
      process.argv = [process.execPath, "benchmark"];
      expect(readCodexOptions().totalTokenLimit).toBe(2_000_000);
    } finally {
      process.argv = original;
    }
  });

  it("previews the eight-runner matrix reproducibly without creating trial artifacts", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "codex-schedule-"));

    try {
      const args = [
        "benchmarks/codex-discovery/run.ts",
        "--dry-run",
        "--output",
        nodePath.join(directory, "unused"),
      ];

      const first = await execa(process.execPath, args);
      const second = await execa(process.execPath, args);
      expect(second.stdout).toBe(first.stdout);

      const plan = decodeJson(
        Schema.Struct({
          trials: Schema.mutableKey(
            Schema.mutable(
              Schema.Array(
                Schema.Struct({
                  condition: Schema.mutableKey(Schema.String),
                  effort: Schema.mutableKey(Schema.String),
                  model: Schema.mutableKey(Schema.String),
                })
              )
            )
          ),
        }),
        first.stdout
      );

      expect(plan.trials).toHaveLength(240);

      const continuation = await execa(process.execPath, [
        ...args,
        "--start-at",
        "155",
      ]);

      expect([
        decodeJson(
          Schema.Struct({ trials: Schema.Array(Schema.JsonObject) }),
          continuation.stdout
        ).trials,
        [...new Set(plan.trials.map(({ condition }) => condition))].toSorted(),
        [
          ...new Set(
            plan.trials.map(({ model, effort }) => `${model}/${effort}`)
          ),
        ].toSorted(),
      ]).toStrictEqual([
        plan.trials.slice(155),
        ["files", "typepeek-skill"],
        [
          "gpt-5.6-luna/high",
          "gpt-5.6-luna/low",
          "gpt-5.6-sol/high",
          "gpt-5.6-sol/low",
          "gpt-5.6-terra/high",
          "gpt-5.6-terra/low",
          "gpt-6-astra/high",
          "gpt-6-astra/low",
        ],
      ]);
      await expect(readdir(directory)).resolves.toStrictEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a matrix that combines all workloads with individual workloads", async () => {
    const result = await execa(
      process.execPath,
      [
        "benchmarks/codex-discovery/run.ts",
        "--dry-run",
        "--cases",
        "all,execa-command",
      ],
      { reject: false }
    );

    expect([
      result.failed,
      result.stderr.includes("all must be used alone"),
    ]).toStrictEqual([true, true]);
  });

  it("records unavailable ripgrep without blocking benchmark setup", async () => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "codex-no-search-tool-")
    );

    try {
      await mkdir(nodePath.join(directory, "dist"));
      await mkdir(nodePath.join(directory, "benchmarks", "support"), {
        recursive: true,
      });
      await writeFile(nodePath.join(directory, "package.json"), "{}");
      await writeFile(nodePath.join(directory, "pnpm-lock.yaml"), "");

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
        { cwd: directory, env: { PATH: directory } }
      );

      expect(result.stdout).toBe("unavailable");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("ignores an optional trailing comma in destructured parameters without changing fields", () => {
    expect([
      signatureFact("call", "({ routes, aliases, }: Routes): Result"),
      Object.is(
        signatureFact("call", "({ routes }: Routes): Result"),
        signatureFact("call", "({ routes, aliases }: Routes): Result")
      ),
    ]).toStrictEqual([
      signatureFact("call", "({ routes, aliases }: Routes): Result"),
      false,
    ]);
  });

  it.each([
    "execa-command",
    "node-exists",
    "effect-option",
    "stricli-routes",
    "typescript-program",
  ])("keeps the %s discovery answer out of every condition's prompt", (id) => {
    const scenario = requireDefined(selectCodexScenarios([id])[0]);
    expect(scenario.discovery).toBeTruthy();

    for (const condition of [
      "files",
      "typepeek",
      "typepeek-skill",
      "typepeek-required",
    ] as const) {
      const prompt = codexPrompt(scenario, condition, "SKILL CONTENT");
      expect([
        prompt.includes(scenario.workload.target),
        prompt.includes(`Question: ${scenario.question}`),
        prompt.includes("rg "),
      ]).toStrictEqual([false, true, false]);
    }
  });

  it("lets both Codex conditions choose their strategy without giving away discovery answers", () => {
    const scenario = requireDefined(selectCodexScenarios(["execa-command"])[0]);
    const baseline = codexPrompt(scenario, "files", "");
    const treatment = codexPrompt(scenario, "typepeek", "");

    for (const prompt of [baseline, treatment]) {
      expect([
        prompt.includes(
          "Choose the fastest reliable local inspection strategy yourself"
        ),
        prompt.includes("parseCommandString"),
        prompt.includes("types/methods/command.d.ts"),
      ]).toStrictEqual([true, false, false]);
    }

    expect([
      baseline.includes("Typepeek is unavailable"),
      treatment.includes("you are not required to call it"),
    ]).toStrictEqual([true, true]);

    const skillPrompt = codexPrompt(
      scenario,
      "typepeek-skill",
      "SKILL CONTENT"
    );

    expect([
      skillPrompt.includes("Use $typepeek"),
      skillPrompt.includes("SKILL CONTENT"),
      treatment.includes("$typepeek"),
    ]).toStrictEqual([true, true, false]);
  });

  it("counts complete Codex usage while retaining cached and reasoning breakdowns", () => {
    const events = [
      {
        item: { command: "typepeek --help", type: "command_execution" },
        type: "item.started",
      },
      {
        item: {
          aggregated_output: "abc",
          command: "typepeek signatures execa parseCommandString --json",
          type: "command_execution",
        },
        type: "item.completed",
      },
      {
        type: "turn.completed",
        usage: {
          cached_input_tokens: 60,
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 10,
        },
      },
      {
        type: "turn.completed",
        usage: {
          cached_input_tokens: 20,
          input_tokens: 50,
          output_tokens: 15,
          reasoning_output_tokens: 5,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    expect([
      codexTelemetry(events),
      codexTelemetry(events).commands.length,
      codexTelemetry('{"type":"turn.failed"}'),
    ]).toStrictEqual([
      match.objectContaining({
        cachedInputTokens: 80,
        completedTurns: 2,
        inputTokens: 150,
        invalidLines: 0,
        outputTokens: 35,
        reasoningOutputTokens: 15,
        toolOutputBytes: 3,
        usedTypepeek: true,
      }),
      1,
      match.objectContaining({
        inputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      }),
    ]);
  });

  it("marks partial or damaged usage logs incomplete while retaining known token counts", () => {
    const complete = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    expect(codexTelemetry(complete).usageComplete).toBeTruthy();

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

    expect(codexTelemetry("").usageComplete).toBeFalsy();
  });

  it("accepts a verified discovered export and rejects invented or incomplete signatures", () => {
    const scenario = requireDefined(selectCodexScenarios(["execa-command"])[0]);
    const expected = ["call:( command : string ) : string [ ]"];

    const answer = {
      exportName: "parseCommandString",
      matches: [],
      signatures: ["(command:string):string[]"],
      specifier: "execa",
      status: "answered",
    };

    expect([
      gradeCodexAnswer(scenario, expected, JSON.stringify(answer)).passed,
      gradeCodexAnswer(
        scenario,
        expected,
        JSON.stringify({ ...answer, signatures: ["(command: string): {}"] })
      ).passed,
      gradeCodexAnswer(
        scenario,
        expected,
        JSON.stringify({ ...answer, signatures: [] })
      ).passed,
      gradeCodexAnswer(
        scenario,
        expected,
        JSON.stringify({ ...answer, exportName: "invented" })
      ).passed,
      gradeCodexAnswer(scenario, expected, "not JSON").passed,
    ]).toStrictEqual([true, false, false, false, false]);
  });

  it("requires task evidence in the required-use condition and keeps availability optional", () => {
    const scenario = requireDefined(selectCodexScenarios(["execa-command"])[0]);

    const completion = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const command = (output: string, exitCode = 0) =>
      codexTelemetry(
        [
          JSON.stringify({
            item: {
              aggregated_output: output,
              command: "typepeek signatures execa parseCommandString --json",
              exit_code: exitCode,
              type: "command_execution",
            },
            type: "item.completed",
          }),
          completion,
        ].join("\n")
      );

    const evidence = JSON.stringify({
      result: {
        intent: "signature-inspection",
        moduleExport: { name: "parseCommandString" },
        specifier: "execa",
      },
      status: "success",
    });

    expect([
      requireDefined(
        gradeCodexExecution(
          scenario,
          "typepeek-required",
          codexTelemetry(completion)
        )
      ).includes("No command"),
      requireDefined(
        gradeCodexExecution(
          scenario,
          "typepeek-required",
          command("Usage: typepeek")
        )
      ).includes("inspection"),
      requireDefined(
        gradeCodexExecution(scenario, "typepeek-required", command(evidence, 1))
      ).includes("inspection"),
      requireDefined(
        gradeCodexExecution(
          scenario,
          "typepeek-required",
          command(evidence.replace("execa", "other"))
        )
      ).includes("inspection"),
      gradeCodexExecution(scenario, "typepeek-required", command(evidence)) ===
        null,
      command(`${evidence}\n`).typepeekEvidence.length,
    ]).toStrictEqual([true, true, true, true, true, 1]);

    const plan = JSON.stringify({
      result: {
        inspections: [
          decodeJson(Schema.Struct({ result: Schema.JsonObject }), evidence)
            .result,
        ],
        intent: "inspection-plan",
      },
      status: "success",
    });

    expect([
      gradeCodexExecution(scenario, "typepeek-required", command(plan)) ===
        null,
      gradeCodexExecution(scenario, "typepeek", command("Usage: typepeek")) ===
        null,
      requireDefined(
        gradeCodexExecution(scenario, "files", command(evidence))
      ).includes("Control"),
    ]).toStrictEqual([true, true, true]);
    const prompt = codexPrompt(scenario, "typepeek-required", "SKILL CONTENT");
    expect([
      prompt.includes("must inspect"),
      prompt.includes("SKILL CONTENT"),
      prompt.includes("you are not required"),
      prompt.includes("parseCommandString"),
    ]).toStrictEqual([true, true, false, false]);
  });

  it("requires the requested name search rather than an unrelated query in the same module", () => {
    const scenario = requireDefined(selectCodexScenarios(["execa-errors"])[0]);

    expect([
      requireDefined(
        gradeCodexExecution(
          scenario,
          "typepeek-required",
          telemetry("unrelated")
        )
      ).includes("inspection"),
      gradeCodexExecution(scenario, "typepeek-required", telemetry("ERROR")) ===
        null,
    ]).toStrictEqual([true, true]);
  });
});
