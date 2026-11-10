import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import type { JsonInput } from "#typepeek/shared/json-data";
import { decodeJson } from "#typepeek/shared/json-data";

import { acquisitionMeasurementSchema } from "./benchmark-artifact.ts";

export const oracle = {
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

export const command = function command(
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

export const replay = async function replay(
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
