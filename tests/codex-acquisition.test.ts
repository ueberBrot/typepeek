import { execa } from "execa";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

const oracle = {
  schemaVersion: 1,
  workload: {
    id: "execa-command",
    specifier: "execa",
    kind: "signatures",
    target: "parseCommandString",
  },
  facts: ["call:( command : string ) : string [ ]"],
  declarations: [
    {
      fact: "call:( command : string ) : string [ ]",
      text: "export function parseCommandString(command: string): string[];",
    },
  ],
  exportDeclarations: [],
};

function command(milliseconds: number, id: string, output?: string) {
  return {
    milliseconds,
    event: {
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item:
          output === undefined
            ? {
                type: "function_call",
                call_id: id,
                name: "exec_command",
                arguments: '{"cmd":"read installed declarations"}',
              }
            : {
                type: "function_call_output",
                call_id: id,
                output,
              },
      },
    },
  };
}

async function replay(events: readonly unknown[], answerKey: unknown = oracle, workspace?: string) {
  const directory = await mkdtemp(join(tmpdir(), "codex-acquisition-"));
  try {
    const tracePath = join(directory, "events.timed.jsonl");
    const oraclePath = join(directory, "oracle.json");
    const outputPath = join(directory, "acquisition.json");
    await writeFile(tracePath, events.map((event) => JSON.stringify(event)).join("\n"));
    await writeFile(oraclePath, JSON.stringify(answerKey));
    const result = await execa(process.execPath, [
      "benchmarks/codex-discovery/replay.ts",
      "--trace",
      tracePath,
      ...(workspace === undefined
        ? ["--oracle", oraclePath]
        : ["--workspace", workspace, "--case", "execa-command"]),
      "--output",
      outputPath,
    ]);
    const saved = JSON.parse(await readFile(outputPath, "utf8"));
    expect(JSON.parse(result.stdout)).toEqual(saved);
    return saved;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("stops retrieval measurement when sufficient evidence arrives, before later work and the final answer", async () => {
  const result = await replay([
    command(1000, "read"),
    command(3000, "read", "export function parseCommandString(command: string): string[];"),
    command(4000, "extra"),
    command(5000, "extra", "Unnecessary additional reading"),
    {
      milliseconds: 9000,
      event: {
        type: "item.completed",
        item: { id: "answer", type: "agent_message", text: "Wrong answer" },
      },
    },
  ]);
  expect(result).toMatchObject({
    status: "complete",
    firstRequestMilliseconds: 1000,
    sufficientEvidenceMilliseconds: 3000,
    retrievalSeconds: 2,
    toolRoundTripSeconds: 2,
    toolExecutionSeconds: null,
    retrievalCalls: 1,
    matchedFacts: ["call:( command : string ) : string [ ]"],
    missingFacts: [],
  });
});

it("builds its evidence answer key independently from the installed declaration and accepts numbered file reads", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codex-oracle-"));
  try {
    const packageRoot = join(workspace, "node_modules", "execa");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"type":"module"}');
    await writeFile(
      join(packageRoot, "package.json"),
      '{"name":"execa","type":"module","types":"index.d.ts"}',
    );
    await writeFile(
      join(packageRoot, "index.d.ts"),
      "export function parseCommandString(command: string): string[];\n",
    );
    const result = await replay(
      [
        command(1000, "read"),
        command(
          2000,
          "read",
          "node_modules/execa/index.d.ts:1:export function parseCommandString(command: string): string[];",
        ),
      ],
      undefined,
      workspace,
    );
    expect(result).toMatchObject({ status: "complete", retrievalSeconds: 1, missingFacts: [] });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("does not credit evidence present only in the command log rather than the tool response", async () => {
  const result = await replay([
    command(1000, "read"),
    {
      milliseconds: 1900,
      event: {
        type: "item.completed",
        item: {
          id: "read",
          type: "command_execution",
          aggregated_output: "export function parseCommandString(command: string): string[];",
          exit_code: 0,
        },
      },
    },
    command(2000, "read", "Output truncated: declaration omitted"),
  ]);
  expect(result).toMatchObject({
    status: "insufficient",
    retrievalSeconds: null,
    matchedFacts: [],
    missingFacts: ["call:( command : string ) : string [ ]"],
  });
});

it("recognizes a declaration after unrelated grep matches with incomplete template syntax", async () => {
  const result = await replay([
    command(1000, "read"),
    command(
      2000,
      "read",
      [
        "node_modules/execa/lib/command.js:4:throw new Error(`Invalid: ${String(command)}.`);",
        "node_modules/execa/types/command.d.ts:2:Split a `command` string, like `$`.",
        "node_modules/execa/types/command.d.ts:19:export function parseCommandString(command: string): string[];",
      ].join("\n"),
    ),
  ]);
  expect(result).toMatchObject({ status: "complete", retrievalSeconds: 1 });
});

it("preserves contiguous numbered declarations without joining gaps or separate files", async () => {
  for (const prefix of ["", "node_modules/execa/index.d.ts:"]) {
    for (const [lastPrefix, lastLine, status] of [
      [prefix, 20, "complete"],
      [prefix, 22, "insufficient"],
      ["node_modules/execa/other.d.ts:", 20, "insufficient"],
    ] as const) {
      const result = await replay([
        command(1000, "read"),
        command(
          2000,
          "read",
          `${prefix}19:export function parseCommandString(\n${lastPrefix}${lastLine}:command: string): string[];`,
        ),
      ]);
      expect(result.status).toBe(status);
    }
  }
});

it("keeps comment and string boundaries when matching unnumbered source", async () => {
  for (const text of [
    `/*\n${oracle.declarations[0]!.text}\n*/`,
    `const example = \`\n${oracle.declarations[0]!.text}\n\`;`,
  ]) {
    const result = await replay([command(1000, "read"), command(2000, "read", text)]);
    expect(result.status).toBe("insufficient");
  }
});

it("combines consecutive numbered reads across responses while preserving file and line boundaries", async () => {
  for (const [file, line, status] of [
    ["index.d.ts", 20, "complete"],
    ["index.d.ts", 22, "insufficient"],
    ["other.d.ts", 20, "insufficient"],
  ] as const) {
    const result = await replay([
      command(1000, "first"),
      command(2000, "first", "Output:\nindex.d.ts:19:export function parseCommandString(\n"),
      command(3000, "second"),
      command(4000, "second", `Output:\n${file}:${line}:command: string): string[];\n`),
    ]);
    expect(result.status).toBe(status);
    expect(result.retrievalSeconds).toBe(status === "complete" ? 3 : null);
  }
});

it("counts returned text with a named reference tokenizer even when retrieval is incomplete", async () => {
  const result = await replay([
    command(1000, "first"),
    command(2000, "first", "Hello, world!"),
    command(3000, "second"),
    command(4000, "second", "Hello, world!"),
  ]);
  expect(result).toMatchObject({
    status: "insufficient",
    evidenceTokens: 8,
    evidenceBytes: 26,
    tokenization: { encoding: "o200k_base", package: "gpt-tokenizer", version: "4.0.0" },
    acquisitionModelUsage: null,
  });
});

it("rejects missing, duplicated, or cross-turn response provenance instead of crediting its evidence", async () => {
  const evidence = "export function parseCommandString(command: string): string[];";
  for (const events of [
    [command(2000, "missing", evidence)],
    [command(1000, "read"), command(2000, "read", "nothing"), command(3000, "read", evidence)],
    [command(2000, "read"), command(1000, "read", evidence)],
    [
      command(1000, "read"),
      {
        ...command(2000, "read", evidence),
        event: {
          ...command(2000, "read", evidence).event,
          params: { ...command(2000, "read", evidence).event.params, turnId: "other" },
        },
      },
    ],
  ]) {
    const result = await replay(events);
    expect(result.status).toBe("invalid");
    expect(result.retrievalSeconds).toBeNull();
  }
});

it("accepts native text-array responses without counting serialization as evidence", async () => {
  const response = command(2000, "read", "");
  const result = await replay([
    command(1000, "read"),
    {
      ...response,
      event: {
        ...response.event,
        params: {
          ...response.event.params,
          item: {
            ...response.event.params.item,
            output: [{ type: "input_text", text: oracle.declarations[0]!.text }],
          },
        },
      },
    },
  ]);
  expect(result.status).toBe("complete");
  expect(result.evidenceBytes).toBe(62);
  const blocks = await replay([
    command(1000, "read"),
    {
      ...response,
      event: {
        ...response.event,
        params: {
          ...response.event.params,
          item: {
            ...response.event.params.item,
            output: [
              { type: "input_text", text: "Hello, world!" },
              { type: "input_text", text: "Hello, world!" },
            ],
          },
        },
      },
    },
  ]);
  expect(blocks).toMatchObject({ evidenceTokens: 8, evidenceBytes: 26 });
});

it("requires a complete public export index to establish an absent name", async () => {
  const absent = {
    ...oracle,
    workload: { ...oracle.workload, kind: "search", target: "missing" },
    facts: [],
    declarations: [],
    exportDeclarations: ["export { parseCommandString } from './command.js';"],
  };
  expect(
    (await replay([command(1000, "read"), command(2000, "read", "No grep matches")], absent))
      .status,
  ).toBe("insufficient");
  expect(
    (
      await replay(
        [command(1000, "read"), command(2000, "read", absent.exportDeclarations[0])],
        absent,
      )
    ).status,
  ).toBe("complete");
});

it("combines declaration and export-index fragments across successive file reads", async () => {
  const declarations = await replay([
    command(1000, "first"),
    command(2000, "first", "Output:\nexport function parseCommandString("),
    command(3000, "second"),
    command(4000, "second", "Output:\ncommand: string): string[];"),
  ]);
  expect(declarations).toMatchObject({ status: "complete", retrievalSeconds: 3 });
  const absent = {
    ...oracle,
    workload: { ...oracle.workload, kind: "search", target: "missing" },
    facts: [],
    declarations: [],
    exportDeclarations: [
      "export { first } from './first.js';\nexport { second } from './second.js';",
    ],
  };
  const index = await replay(
    [
      command(1000, "first"),
      command(2000, "first", "export { first } from './first.js';"),
      command(3000, "second"),
      command(4000, "second", "export { second } from './second.js';"),
    ],
    absent,
  );
  expect(index).toMatchObject({ status: "complete", retrievalSeconds: 3 });
});

it("invalidates unsupported tool content instead of reporting an understated token total", async () => {
  const response = command(2000, "unsupported", "");
  const result = await replay([
    command(1000, "unsupported"),
    {
      ...response,
      event: {
        ...response.event,
        params: {
          ...response.event.params,
          item: {
            ...response.event.params.item,
            output: [
              { type: "input_text", text: "Earlier evidence" },
              { type: "input_image", image_url: "fixture" },
            ],
          },
        },
      },
    },
    command(3000, "read"),
    command(4000, "read", oracle.declarations[0]!.text),
  ]);
  expect(result.status).toBe("invalid");
  expect(result.retrievalSeconds).toBeNull();
});

it("starts acquisition at retrieval, excluding an earlier planning call and its response", async () => {
  const plan = command(1000, "plan");
  const result = await replay([
    {
      ...plan,
      event: {
        ...plan.event,
        params: { ...plan.event.params, item: { ...plan.event.params.item, name: "update_plan" } },
      },
    },
    command(2000, "plan", "Plan updated"),
    command(3000, "read"),
    command(4000, "read", oracle.declarations[0]!.text),
  ]);
  expect(result).toMatchObject({
    status: "complete",
    firstRequestMilliseconds: 3000,
    retrievalSeconds: 1,
    retrievalCalls: 1,
    evidenceBytes: 62,
  });
});

it("waits for every overload across tool responses and includes the gap between retrieval calls", async () => {
  const overloaded = {
    ...oracle,
    facts: [...oracle.facts, "call:( command : readonly string [ ] ) : string [ ]"],
    declarations: [
      ...oracle.declarations,
      {
        fact: "call:( command : readonly string [ ] ) : string [ ]",
        text: "export function parseCommandString(command: readonly string[]): string[];",
      },
    ],
  };
  const output = (text: string) =>
    `Output:\n${JSON.stringify(
      {
        status: "success",
        result: {
          intent: "signature-inspection",
          specifier: "execa",
          moduleExport: { name: "parseCommandString", signatures: [{ kind: "call", text }] },
        },
      },
      null,
      2,
    )}`;
  const result = await replay(
    [
      command(1000, "first"),
      command(2000, "first", output("(command: string): string[]")),
      command(6000, "second"),
      command(8000, "second", output("(command: readonly string[]): string[]")),
    ],
    overloaded,
  );
  expect(result).toMatchObject({
    status: "complete",
    retrievalSeconds: 7,
    toolRoundTripSeconds: 3,
    retrievalCalls: 2,
    sufficientEvidenceMilliseconds: 8000,
    missingFacts: [],
  });
});

it("captures tool responses while the server is running instead of timestamping them after the final answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-capture-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await cp("tests/fixtures/codex-app-server.mjs", join(bin, "codex"));
    await chmod(join(bin, "codex"), 0o755);
    const launchPath = join(directory, "launch.json");
    await writeFile(
      launchPath,
      JSON.stringify({
        workspace: directory,
        model: "gpt-5.6-luna",
        effort: "low",
        prompt: "fixture",
        configArguments: [],
        timeoutMilliseconds: 5000,
      }),
    );
    const output = join(directory, "captured");
    await execa(
      process.execPath,
      ["benchmarks/codex-discovery/capture.ts", "--launch", launchPath, "--output", output],
      {
        env: { PATH: `${bin}:${process.env["PATH"]}` },
      },
    );
    const captured = JSON.parse(await readFile(join(output, "capture.json"), "utf8"));
    const events = (await readFile(join(output, "events.timed.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = await replay(events);
    expect(result.status).toBe("complete");
    expect(result.retrievalSeconds).toBeGreaterThan(0);
    expect(result.sufficientEvidenceMilliseconds).toBeLessThan(
      captured.turnCompletedMilliseconds - 100,
    );
    expect(captured.answer).toBe("A late final answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("grades an acquisition campaign by retrieved evidence even when the final answers are wrong", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-acquisition-study-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await cp("tests/fixtures/codex-app-server.mjs", join(bin, "codex"));
    await chmod(join(bin, "codex"), 0o755);
    const output = join(directory, "study");
    await execa(
      process.execPath,
      [
        "benchmarks/codex-discovery/run.ts",
        "--cases",
        "execa-command",
        "--models",
        "gpt-5.6-luna",
        "--efforts",
        "low",
        "--repeats",
        "1",
        "--output",
        output,
      ],
      { env: { PATH: `${bin}:${process.env["PATH"]}` }, timeout: 60000 },
    );
    const study = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
    expect(study.schemaVersion).toBe(3);
    expect(study.attempts).toHaveLength(3);
    for (const attempt of study.attempts) {
      expect(attempt).toMatchObject({
        passed: true,
        acquisition: { status: "complete", missingFacts: [] },
        finalAnswer: { passed: false },
      });
      expect(attempt.acquisition.retrievalSeconds).toBeLessThan(attempt.seconds);
      expect(attempt.acquisition.evidenceTokens).toBeGreaterThan(0);
      const group = study.groups.find(
        (value: { condition: string }) => value.condition === attempt.condition,
      );
      expect(group.successfulSeconds.mean).toBe(attempt.acquisition.retrievalSeconds);
      expect(group.successfulEvidenceTokens.mean).toBe(attempt.acquisition.evidenceTokens);
      expect(group.wholeRun.successfulSeconds.mean).toBe(attempt.seconds);
      expect(attempt.instructionTokens.prompt).toBeGreaterThan(0);
      expect(attempt.instructionTokens.skill).toBe(
        attempt.condition === "typepeek-skill"
          ? study.attempts.find(
              (value: { condition: string }) => value.condition === "typepeek-skill",
            ).instructionTokens.skill
          : 0,
      );
      expect(group.coverageComplete).toBe(true);
      expect(group.precisionWithinTenPercent).toBeNull();
    }
    expect(await readFile(join(output, "summary.md"), "utf8")).toContain("Time to evidence");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains completed acquisition and known usage when final-answer generation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-late-failure-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await cp("tests/fixtures/codex-app-server.mjs", join(bin, "codex"));
    await chmod(join(bin, "codex"), 0o755);
    const output = join(directory, "study");
    await execa(
      process.execPath,
      [
        "benchmarks/codex-discovery/run.ts",
        "--cases",
        "execa-command",
        "--models",
        "gpt-5.6-luna",
        "--efforts",
        "low",
        "--conditions",
        "files",
        "--repeats",
        "1",
        "--output",
        output,
      ],
      {
        env: { PATH: `${bin}:${process.env["PATH"]}`, CODEX_FIXTURE_FAIL_LATE: "1" },
        reject: false,
        timeout: 60000,
      },
    );
    const study = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
    expect(study.attempts[0]).toMatchObject({
      passed: true,
      wholeRunError: "Late model failure",
      telemetry: { inputTokens: 100, outputTokens: 20, usageComplete: false },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
