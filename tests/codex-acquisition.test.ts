import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import type { JsonInput } from "#typepeek/json-data";
import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import {
  acquisitionMeasurementSchema,
  captureReceiptSchema,
  discoveryStudySchema,
} from "./helpers/benchmark-artifact.ts";
import { installCodexFixture } from "./helpers/codex-fixture.ts";
import { match } from "./helpers/matchers.ts";

const formatToolOutput = (text: string) =>
  `Output:\n${JSON.stringify(
    {
      result: {
        intent: "signature-inspection",
        moduleExport: {
          name: "clean",
          signatures: [{ kind: "call", text }],
        },
        specifier: "semver",
      },
      status: "success",
    },
    null,
    2
  )}`;

const oracle = {
  declarations: [
    {
      fact: "call:( version : string , optionsOrLoose ? : boolean | semver . Options ) : string | null",
      text: "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;",
    },
  ],
  exportDeclarations: [],
  facts: [
    "call:( version : string , optionsOrLoose ? : boolean | semver . Options ) : string | null",
  ],
  schemaVersion: 1,
  workload: {
    id: "semver-clean",
    kind: "signatures",
    specifier: "semver",
    target: "clean",
  },
};

const command = function command(
  milliseconds: number,
  id: string,
  output?: string
) {
  return {
    event: {
      method: "rawResponseItem/completed",
      params: {
        item:
          output === undefined
            ? {
                arguments: '{"cmd":"read installed declarations"}',
                call_id: id,
                name: "exec_command",
                type: "function_call",
              }
            : {
                call_id: id,
                output,
                type: "function_call_output",
              },
        threadId: "thread",
        turnId: "turn",
      },
    },
    milliseconds,
  };
};

const replay = async function replay(
  events: readonly JsonInput[],
  answerKey: JsonInput = oracle,
  workspace?: string
) {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "codex-acquisition-")
  );

  try {
    const tracePath = nodePath.join(directory, "events.timed.jsonl");
    const oraclePath = nodePath.join(directory, "oracle.json");
    const outputPath = nodePath.join(directory, "acquisition.json");
    await writeFile(
      tracePath,
      events.map((event) => JSON.stringify(event)).join("\n")
    );
    await writeFile(oraclePath, JSON.stringify(answerKey));

    const result = await runCommand(process.execPath, [
      "benchmarks/codex-discovery/replay.ts",
      "--trace",
      tracePath,
      ...(workspace === undefined
        ? ["--oracle", oraclePath]
        : ["--workspace", workspace, "--case", "semver-clean"]),
      "--output",
      outputPath,
    ]);

    const saved = decodeJson(
      acquisitionMeasurementSchema,
      await readFile(outputPath, "utf-8")
    );

    expect(
      decodeJson(acquisitionMeasurementSchema, result.stdout)
    ).toStrictEqual(saved);

    return saved;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

describe("codex-acquisition", () => {
  beforeAll(async () => {
    await runCommand("vp", ["pack"]);
  }, 60_000);

  it.each([
    requireDefined(oracle.declarations[0]).text,
    JSON.stringify({
      result: {
        intent: "export-search",
        matches: [
          {
            name: "clean",
            signatures: [
              {
                kind: "call",
                text: "(version: string, optionsOrLoose?: boolean | semver.Options): string | null",
              },
            ],
          },
        ],
        query: "split",
        scope: "documentation",
        specifier: "semver",
      },
      status: "success",
    }),
    ...["signature-inspection", "export-inspection"].map((intent) =>
      JSON.stringify({
        result: {
          intent,
          moduleExport: {
            name: "clean",
            signatures: [
              {
                kind: "call",
                text: "(version: string, optionsOrLoose?: boolean | semver.Options): string | null",
              },
            ],
          },
          specifier: "semver",
        },
        status: "success",
      })
    ),
  ])(
    "recognizes evidence inside Codex command-result JSON wrappers: %s",
    async (output) => {
      const wrapped = `Script completed\nOutput:\n${JSON.stringify({
        chunk_id: "test",
        exit_code: 0,
        output,
        wall_time_seconds: 0.01,
      })}`;

      const result = await replay([
        command(1000, "read"),
        command(2000, "read", wrapped),
      ]);

      expect([
        result.status,
        result.sufficientEvidenceMilliseconds,
        result.evidenceBytes,
      ]).toStrictEqual(["complete", 2000, Buffer.byteLength(wrapped)]);
    }
  );

  it("does not treat arbitrary JSON output fields as command-result evidence", async () => {
    const result = await replay([
      command(1000, "read"),
      command(
        2000,
        "read",
        JSON.stringify({ output: requireDefined(oracle.declarations[0]).text })
      ),
    ]);

    expect(result.status).toBe("insufficient");
  });

  it("stops retrieval measurement when sufficient evidence arrives, before later work and the final answer", async () => {
    const result = await replay([
      {
        event: {
          method: "benchmark/taskSubmitted",
          params: { threadId: "thread" },
        },
        milliseconds: 100,
      },
      command(1000, "read"),
      command(
        3000,
        "read",
        "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;"
      ),
      command(4000, "extra"),
      command(5000, "extra", "Unnecessary additional reading"),
      {
        event: {
          item: { id: "answer", text: "Wrong answer", type: "agent_message" },
          type: "item.completed",
        },
        milliseconds: 9000,
      },
    ]);

    expect(result).toMatchObject({
      firstRequestMilliseconds: 1000,
      matchedFacts: [
        "call:( version : string , optionsOrLoose ? : boolean | semver . Options ) : string | null",
      ],
      missingFacts: [],
      retrievalCalls: 1,
      retrievalSeconds: 2,
      status: "complete",
      sufficientEvidenceMilliseconds: 3000,
      taskSubmittedMilliseconds: 100,
      taskToEvidenceSeconds: 2.9,
      toolExecutionSeconds: null,
      toolRoundTripSeconds: 2,
    });
  });

  it("builds its evidence answer key independently from the installed declaration and accepts numbered file reads", async () => {
    const workspace = await mkdtemp(nodePath.join(tmpdir(), "codex-oracle-"));

    try {
      const packageRoot = nodePath.join(workspace, "node_modules", "semver");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        nodePath.join(workspace, "package.json"),
        '{"type":"module"}'
      );
      await writeFile(
        nodePath.join(packageRoot, "package.json"),
        '{"name":"semver","type":"module","types":"index.d.ts"}'
      );
      await writeFile(
        nodePath.join(packageRoot, "index.d.ts"),
        "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;\ndeclare namespace semver { interface Options { readonly loose?: boolean; } }\n"
      );

      const result = await replay(
        [
          command(1000, "read"),
          command(
            2000,
            "read",
            "node_modules/semver/index.d.ts:1:export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;"
          ),
        ],
        undefined,
        workspace
      );

      expect(result).toMatchObject({
        missingFacts: [],
        retrievalSeconds: 1,
        status: "complete",
        taskToEvidenceSeconds: null,
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("does not credit evidence present only in the command log rather than the tool response", async () => {
    const result = await replay([
      command(1000, "read"),
      {
        event: {
          item: {
            aggregated_output:
              "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;",
            exit_code: 0,
            id: "read",
            type: "command_execution",
          },
          type: "item.completed",
        },
        milliseconds: 1900,
      },
      command(2000, "read", "Output truncated: declaration omitted"),
    ]);

    expect(result).toMatchObject({
      matchedFacts: [],
      missingFacts: [
        "call:( version : string , optionsOrLoose ? : boolean | semver . Options ) : string | null",
      ],
      retrievalSeconds: null,
      status: "insufficient",
    });
  });

  it("recognizes a declaration after unrelated grep matches with incomplete template syntax", async () => {
    const result = await replay([
      command(1000, "read"),
      command(
        2000,
        "read",
        [
          `node_modules/semver/lib/command.js:4:throw new Error(\`Invalid: \${String(command)}.\`);`,
          "node_modules/semver/types/command.d.ts:2:Split a `command` string, like `$`.",
          "node_modules/semver/types/command.d.ts:19:export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;",
        ].join("\n")
      ),
    ]);

    expect(result).toMatchObject({ retrievalSeconds: 1, status: "complete" });
  });

  it("preserves contiguous numbered declarations without joining gaps or separate files", async () => {
    await Array.fromAsync(
      ["", "node_modules/semver/index.d.ts:"],
      async (prefix) => {
        await Array.fromAsync(
          [
            [prefix, 20, "complete"],
            [prefix, 22, "insufficient"],
            ["node_modules/semver/other.d.ts:", 20, "insufficient"],
          ] as const,
          async ([lastPrefix, lastLine, status]) => {
            const result = await replay([
              command(1000, "read"),
              command(
                2000,
                "read",
                `${prefix}19:export declare function clean(\n${lastPrefix}${lastLine}:version: string, optionsOrLoose?: boolean | semver.Options): string | null;`
              ),
            ]);

            expect(result.status).toBe(status);
          }
        );
      }
    );
  });

  it("keeps comment and string boundaries when matching unnumbered source", async () => {
    await Array.fromAsync(
      [
        `/*\n${requireDefined(oracle.declarations[0]).text}\n*/`,
        `const example = \`\n${requireDefined(oracle.declarations[0]).text}\n\`;`,
      ],
      async (text) => {
        const result = await replay([
          command(1000, "read"),
          command(2000, "read", text),
        ]);

        expect(result.status).toBe("insufficient");
      }
    );
  });

  it("combines consecutive numbered reads across responses while preserving file and line boundaries", async () => {
    await Array.fromAsync(
      [
        ["index.d.ts", 20, "complete"],
        ["index.d.ts", 22, "insufficient"],
        ["other.d.ts", 20, "insufficient"],
      ] as const,
      async ([file, line, status]) => {
        const result = await replay([
          command(1000, "first"),
          command(
            2000,
            "first",
            "Output:\nindex.d.ts:19:export declare function clean(\n"
          ),
          command(3000, "second"),
          command(
            4000,
            "second",
            `Output:\n${file}:${line}:version: string, optionsOrLoose?: boolean | semver.Options): string | null;\n`
          ),
        ]);

        expect([
          Object.is(result.status, status),
          result.retrievalSeconds,
        ]).toStrictEqual([true, status === "complete" ? 3 : null]);
      }
    );
  });

  it("counts returned text with a named reference tokenizer even when retrieval is incomplete", async () => {
    const result = await replay([
      command(1000, "first"),
      command(2000, "first", "Hello, world!"),
      command(3000, "second"),
      command(4000, "second", "Hello, world!"),
    ]);

    expect(result).toMatchObject({
      acquisitionModelUsage: null,
      evidenceBytes: 26,
      evidenceTokens: 8,
      status: "insufficient",
      tokenization: {
        encoding: "o200k_base",
        package: "gpt-tokenizer",
        version: "4.1.0",
      },
    });
  });

  it("rejects missing, duplicated, or cross-turn response provenance instead of crediting its evidence", async () => {
    const evidence =
      "export declare function clean(version: string, optionsOrLoose?: boolean | semver.Options): string | null;";

    await Array.fromAsync(
      [
        [command(2000, "missing", evidence)],
        [
          command(1000, "read"),
          command(2000, "read", "nothing"),
          command(3000, "read", evidence),
        ],
        [command(2000, "read"), command(1000, "read", evidence)],
        [
          command(1000, "read"),
          {
            ...command(2000, "read", evidence),
            event: {
              ...command(2000, "read", evidence).event,
              params: {
                ...command(2000, "read", evidence).event.params,
                turnId: "other",
              },
            },
          },
        ],
      ],
      async (events) => {
        const result = await replay(events);
        expect([result.status, result.retrievalSeconds === null]).toStrictEqual(
          ["invalid", true]
        );
      }
    );
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
              output: [
                {
                  text: requireDefined(oracle.declarations[0]).text,
                  type: "input_text",
                },
              ],
            },
          },
        },
      },
    ]);

    expect([result.status, result.evidenceBytes]).toStrictEqual([
      "complete",
      Buffer.byteLength(requireDefined(oracle.declarations[0]).text),
    ]);

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
                { text: "Hello, world!", type: "input_text" },
                { text: "Hello, world!", type: "input_text" },
              ],
            },
          },
        },
      },
    ]);

    expect(blocks).toMatchObject({ evidenceBytes: 26, evidenceTokens: 8 });
  });

  it("requires a complete public export index to establish an absent name", async () => {
    const absent = {
      ...oracle,
      declarations: [],
      exportDeclarations: ["export { clean } from './command.js';"],
      facts: [],
      workload: { ...oracle.workload, kind: "search", target: "missing" },
    };

    const replayResult = await replay(
      [command(1000, "read"), command(2000, "read", "No grep matches")],
      absent
    );

    const replayResult2 = await replay(
      [
        command(1000, "read"),
        command(2000, "read", absent.exportDeclarations[0]),
      ],
      absent
    );

    expect([replayResult.status, replayResult2.status]).toStrictEqual([
      "insufficient",
      "complete",
    ]);
  });

  it("combines declaration and export-index fragments across successive file reads", async () => {
    const declarations = await replay([
      command(1000, "first"),
      command(2000, "first", "Output:\nexport declare function clean("),
      command(3000, "second"),
      command(
        4000,
        "second",
        "Output:\nversion: string, optionsOrLoose?: boolean | semver.Options): string | null;"
      ),
    ]);

    expect(declarations).toMatchObject({
      retrievalSeconds: 3,
      status: "complete",
    });

    const absent = {
      ...oracle,
      declarations: [],
      exportDeclarations: [
        "export { first } from './first.js';\nexport { second } from './second.js';",
      ],
      facts: [],
      workload: { ...oracle.workload, kind: "search", target: "missing" },
    };

    const index = await replay(
      [
        command(1000, "first"),
        command(2000, "first", "export { first } from './first.js';"),
        command(3000, "second"),
        command(4000, "second", "export { second } from './second.js';"),
      ],
      absent
    );

    expect(index).toMatchObject({ retrievalSeconds: 3, status: "complete" });
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
                { text: "Earlier evidence", type: "input_text" },
                { image_url: "fixture", type: "input_image" },
              ],
            },
          },
        },
      },
      command(3000, "read"),
      command(4000, "read", requireDefined(oracle.declarations[0]).text),
    ]);

    expect([result.status, result.retrievalSeconds === null]).toStrictEqual([
      "invalid",
      true,
    ]);
  });

  it("starts acquisition at retrieval, excluding an earlier planning call and its response", async () => {
    const plan = command(1000, "plan");

    const result = await replay([
      {
        ...plan,
        event: {
          ...plan.event,
          params: {
            ...plan.event.params,
            item: { ...plan.event.params.item, name: "update_plan" },
          },
        },
      },
      command(2000, "plan", "Plan updated"),
      command(3000, "read"),
      command(4000, "read", requireDefined(oracle.declarations[0]).text),
    ]);

    expect(result).toMatchObject({
      evidenceBytes: Buffer.byteLength(
        requireDefined(oracle.declarations[0]).text
      ),
      firstRequestMilliseconds: 3000,
      retrievalCalls: 1,
      retrievalSeconds: 1,
      status: "complete",
    });
  });

  it("waits for every overload across tool responses and includes the gap between retrieval calls", async () => {
    const overloaded = {
      ...oracle,
      declarations: [
        ...oracle.declarations,
        {
          fact: "call:( command : readonly string [ ] ) : string [ ]",
          text: "export declare function clean(command: readonly string[]): string[];",
        },
      ],
      facts: [
        ...oracle.facts,
        "call:( command : readonly string [ ] ) : string [ ]",
      ],
    };

    const result = await replay(
      [
        command(1000, "first"),
        command(
          2000,
          "first",
          formatToolOutput(
            "(version: string, optionsOrLoose?: boolean | semver.Options): string | null"
          )
        ),
        command(6000, "second"),
        command(
          8000,
          "second",
          formatToolOutput("(command: readonly string[]): string[]")
        ),
      ],
      overloaded
    );

    expect(result).toMatchObject({
      missingFacts: [],
      retrievalCalls: 2,
      retrievalSeconds: 7,
      status: "complete",
      sufficientEvidenceMilliseconds: 8000,
      toolRoundTripSeconds: 3,
    });
  });

  it("grades requested Inspection Results inside successful Inspection Plans", async () => {
    const signature = {
      intent: "signature-inspection",
      moduleExport: {
        name: oracle.workload.target,
        signatures: [
          {
            kind: "call",
            text: "(version: string, optionsOrLoose?: boolean | semver.Options): string | null",
          },
        ],
      },
      specifier: oracle.workload.specifier,
    };

    const searchOracle = {
      ...oracle,
      declarations: [],
      exportDeclarations: [],
      facts: ["ParseError"],
      workload: { ...oracle.workload, kind: "search", target: "error" },
    };

    const search = {
      intent: "export-search",
      matches: [{ name: "ParseError" }],
      query: "error",
      specifier: oracle.workload.specifier,
    };

    await Array.fromAsync(
      [
        [oracle, signature],
        [searchOracle, search],
      ] as const,
      async ([answerKey, inspection]) => {
        await Array.fromAsync(["success", "failed"], async (status) => {
          await Array.fromAsync(
            [oracle.workload.specifier, "unrelated"],
            async (specifier) => {
              const result = await replay(
                [
                  command(1000, "read"),
                  command(
                    2000,
                    "read",
                    JSON.stringify({
                      result: {
                        inspections: [
                          { ...inspection, specifier: "other" },
                          { ...inspection, specifier },
                        ],
                        intent: "inspection-plan",
                      },
                      status,
                    })
                  ),
                ],
                answerKey
              );

              expect(result.status).toBe(
                status === "success" && specifier === oracle.workload.specifier
                  ? "complete"
                  : "insufficient"
              );
            }
          );
        });
      }
    );
  });

  it("grades case-insensitive Module Export Searches without accepting a different query or Specifier", async () => {
    const answerKey = {
      ...oracle,
      declarations: [],
      exportDeclarations: [],
      facts: ["ParseError"],
      workload: { ...oracle.workload, kind: "search", target: "error" },
    };

    await Array.fromAsync([false, true], async (plan) => {
      await Array.fromAsync(
        [
          ["ERROR", "semver", "complete"],
          ["Error", "semver", "complete"],
          ["failure", "semver", "insufficient"],
          ["error", "SEMVER", "insufficient"],
        ],
        async ([query, specifier, status]) => {
          const inspection = {
            intent: "export-search",
            matches: [{ name: "ParseError" }],
            query,
            specifier,
          };

          const result = await replay(
            [
              command(1000, "read"),
              command(
                2000,
                "read",
                JSON.stringify({
                  result: plan
                    ? { inspections: [inspection], intent: "inspection-plan" }
                    : inspection,
                  status: "success",
                })
              ),
            ],
            answerKey
          );

          expect(result.status).toBe(status);
        }
      );
    });
  });

  it("captures tool responses while the server is running instead of timestamping them after the final answer", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "codex-capture-"));
    const output = nodePath.join(directory, "captured");

    try {
      const bin = nodePath.join(directory, "bin");
      await mkdir(bin);
      await installCodexFixture(bin);
      const launchPath = nodePath.join(directory, "launch.json");
      await writeFile(
        launchPath,
        JSON.stringify({
          configArguments: [],
          effort: "low",
          model: "gpt-5.6-luna",
          prompt: "fixture",
          timeoutMilliseconds: 5000,
          workspace: directory,
        })
      );

      await runCommand(
        process.execPath,
        [
          "benchmarks/codex-discovery/capture.ts",
          "--launch",
          launchPath,
          "--output",
          output,
        ],
        {
          env: { PATH: `${bin}:${process.env["PATH"]}` },
        }
      );

      const captured = decodeJson(
        captureReceiptSchema,
        await readFile(nodePath.join(output, "capture.json"), "utf-8")
      );

      const readFileResult = await readFile(
        nodePath.join(output, "events.timed.jsonl"),
        "utf-8"
      );

      const events = readFileResult
        .trim()
        .split("\n")
        .map((line) => decodeJson(Schema.MutableJson, line));

      const result = await replay(events);
      expect([
        result.status,
        requireDefined(result.retrievalSeconds) > 0,
        requireDefined(result.sufficientEvidenceMilliseconds) <
          requireDefined(captured.turnCompletedMilliseconds) - 100,
        captured.answer,
      ]).toStrictEqual(["complete", true, true, "A late final answer"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects overflowing numeric JSON-RPC IDs before waiting for a response", async () => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "codex-capture-overflow-")
    );

    const output = nodePath.join(directory, "captured");

    try {
      const bin = nodePath.join(directory, "bin");
      await mkdir(bin);
      await installCodexFixture(bin);
      const launchPath = nodePath.join(directory, "launch.json");
      await writeFile(
        launchPath,
        JSON.stringify({
          configArguments: [],
          effort: "low",
          model: "gpt-5.6-luna",
          prompt: "fixture",
          timeoutMilliseconds: 5000,
          workspace: directory,
        })
      );

      const result = await runCommand(
        process.execPath,
        [
          "benchmarks/codex-discovery/capture.ts",
          "--launch",
          launchPath,
          "--output",
          output,
        ],
        {
          env: {
            CODEX_FIXTURE_NONFINITE_ID: "1",
            PATH: `${bin}:${process.env["PATH"]}`,
          },
          reject: false,
        }
      );

      const captured = decodeJson(
        captureReceiptSchema,
        await readFile(nodePath.join(output, "capture.json"), "utf-8")
      );

      expect([
        result.exitCode,
        captured.failureKind,
        captured.timedOut,
        captured.error,
      ]).toStrictEqual([1, "protocol", false, "Expected JSON value"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("grades an acquisition campaign by retrieved evidence even when the final answers are wrong", async () => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "codex-acquisition-study-")
    );

    const output = nodePath.join(directory, "study");

    try {
      const bin = nodePath.join(directory, "bin");
      await mkdir(bin);
      await installCodexFixture(bin);

      await runCommand(
        process.execPath,
        [
          "benchmarks/codex-discovery/run.ts",
          "--cases",
          "semver-clean",
          "--models",
          "gpt-5.6-luna",
          "--efforts",
          "low",
          "--repeats",
          "1",
          "--output",
          output,
        ],
        { env: { PATH: `${bin}:${process.env["PATH"]}` }, timeout: 60_000 }
      );

      const study = decodeJson(
        discoveryStudySchema,
        await readFile(nodePath.join(output, "summary.json"), "utf-8")
      );

      expect([study.schemaVersion, study.attempts.length]).toStrictEqual([
        4, 2,
      ]);

      for (const attempt of study.attempts) {
        expect([
          attempt,
          requireDefined(requireDefined(attempt.acquisition).retrievalSeconds) <
            attempt.seconds,
          requireDefined(
            requireDefined(attempt.acquisition).taskToEvidenceSeconds
          ) >
            requireDefined(
              requireDefined(attempt.acquisition).retrievalSeconds
            ),
          requireDefined(attempt.acquisition).evidenceTokens > 0,
        ]).toStrictEqual([
          match.objectContaining({
            acquisition: match.objectContaining({
              missingFacts: [],
              status: "complete",
            }),
            finalAnswer: match.objectContaining({ passed: false }),
            passed: true,
          }),
          true,
          true,
          true,
        ]);

        const group = study.groups.find(
          (value: { condition: string }) =>
            value.condition === attempt.condition
        );

        expect([
          requireDefined(requireDefined(group).successfulSeconds).mean,
          requireDefined(requireDefined(group).successfulEvidenceTokens).mean,
          requireDefined(requireDefined(group).wholeRun.successfulSeconds).mean,
          requireDefined(attempt.instructionTokens).prompt > 0,
          requireDefined(attempt.instructionTokens).skill,
          requireDefined(group).coverageComplete,
          requireDefined(group).precisionWithinTenPercent === null,
        ]).toStrictEqual([
          requireDefined(attempt.acquisition).taskToEvidenceSeconds,
          requireDefined(attempt.acquisition).evidenceTokens,
          attempt.seconds,
          true,
          attempt.condition === "typepeek-skill"
            ? requireDefined(
                requireDefined(
                  study.attempts.find(
                    (value: { condition: string }) =>
                      value.condition === "typepeek-skill"
                  )
                ).instructionTokens
              ).skill
            : 0,
          true,
          true,
        ]);
      }

      await expect(
        readFile(nodePath.join(output, "summary.md"), "utf-8")
      ).resolves.toContain("Task-to-evidence time");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 75_000);

  it.each([
    ["CODEX_FIXTURE_FAIL_LATE", "Late model failure", true, false],
    ["CODEX_FIXTURE_FAIL_CLEANUP", "Terminal cleanup failed", true, true],
    ["CODEX_FIXTURE_FAIL_EARLY", "Early model failure", false, false],
    [
      "CODEX_FIXTURE_CROSS_THREAD_CLEANUP",
      "Received another thread's turn.",
      false,
      false,
    ],
  ] as const)(
    "keeps task outcomes separate from whole-run failure: %s",
    async (flag, error, passed, usageComplete) => {
      const directory = await mkdtemp(
        nodePath.join(tmpdir(), "codex-late-failure-")
      );

      const output = nodePath.join(directory, "study");

      try {
        const bin = nodePath.join(directory, "bin");
        await mkdir(bin);
        await installCodexFixture(bin);

        await runCommand(
          process.execPath,
          [
            "benchmarks/codex-discovery/run.ts",
            "--cases",
            "semver-clean",
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
            env: { PATH: `${bin}:${process.env["PATH"]}`, [flag]: "1" },
            reject: false,
            timeout: 60_000,
          }
        );

        const study = decodeJson(
          discoveryStudySchema,
          await readFile(nodePath.join(output, "summary.json"), "utf-8")
        );

        expect([study.attempts[0], study.groups[0]]).toStrictEqual([
          match.objectContaining({
            classification: "task",
            passed,
            telemetry: match.objectContaining({
              inputTokens: 100,
              outputTokens: 20,
              usageComplete,
            }),
            wholeRunError: error,
          }),
          match.objectContaining({
            attempts: 1,
            evidenceComplete: passed ? 1 : 0,
            infrastructureFailures: 0,
            successRate: passed ? 1 : 0,
          }),
        ]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
    75_000
  );

  it("preserves an existing replay artifact instead of overwriting it", async () => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "codex-replay-preservation-")
    );

    const output = nodePath.join(directory, "acquisition.json");

    try {
      const trace = nodePath.join(directory, "events.timed.jsonl");
      const answerKey = nodePath.join(directory, "oracle.json");

      await writeFile(
        trace,
        [
          command(1000, "read"),
          command(2000, "read", requireDefined(oracle.declarations[0]).text),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n")
      );
      await writeFile(answerKey, JSON.stringify(oracle));
      await writeFile(output, "retained evidence");

      const result = await runCommand(
        process.execPath,
        [
          "benchmarks/codex-discovery/replay.ts",
          "--trace",
          trace,
          "--oracle",
          answerKey,
          "--output",
          output,
        ],
        { reject: false }
      );

      expect([result.failed, result.stderr.includes("EEXIST")]).toStrictEqual([
        true,
        true,
      ]);
      await expect(readFile(output, "utf-8")).resolves.toBe(
        "retained evidence"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
