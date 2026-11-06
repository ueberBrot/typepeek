import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";

import { oracle, command, replay } from "../helpers/acquisition-fixture.ts";

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

export const registerAcquisitionReplayTests =
  function registerAcquisitionReplayTests(): void {
    test.each([
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

    test("does not treat arbitrary JSON output fields as command-result evidence", async () => {
      const result = await replay([
        command(1000, "read"),
        command(
          2000,
          "read",
          JSON.stringify({
            output: requireDefined(oracle.declarations[0]).text,
          })
        ),
      ]);

      expect(result.status).toBe("insufficient");
    });

    test("stops retrieval measurement when sufficient evidence arrives, before later work and the final answer", async () => {
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

    test("builds its evidence answer key independently from the installed declaration and accepts numbered file reads", async () => {
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

    test("does not credit evidence present only in the command log rather than the tool response", async () => {
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

    test("recognizes a declaration after unrelated grep matches with incomplete template syntax", async () => {
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

    test("preserves contiguous numbered declarations without joining gaps or separate files", async () => {
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

    test("keeps comment and string boundaries when matching unnumbered source", async () => {
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

    test("combines consecutive numbered reads across responses while preserving file and line boundaries", async () => {
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

    test("counts returned text with a named reference tokenizer even when retrieval is incomplete", async () => {
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

    test("rejects missing, duplicated, or cross-turn response provenance instead of crediting its evidence", async () => {
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
          expect([
            result.status,
            result.retrievalSeconds === null,
          ]).toStrictEqual(["invalid", true]);
        }
      );
    });

    test("accepts native text-array responses without counting serialization as evidence", async () => {
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

    test("requires a complete public export index to establish an absent name", async () => {
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

    test("combines declaration and export-index fragments across successive file reads", async () => {
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

    test("invalidates unsupported tool content instead of reporting an understated token total", async () => {
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

    test("starts acquisition at retrieval, excluding an earlier planning call and its response", async () => {
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

    test("waits for every overload across tool responses and includes the gap between retrieval calls", async () => {
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

    test("grades requested Inspection Results inside successful Inspection Plans", async () => {
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
                  status === "success" &&
                    specifier === oracle.workload.specifier
                    ? "complete"
                    : "insufficient"
                );
              }
            );
          });
        }
      );
    });

    test("grades case-insensitive Module Export Searches without accepting a different query or Specifier", async () => {
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
  };
