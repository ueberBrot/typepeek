import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Schema } from "effect";

import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import {
  assertArtifactCacheReuse,
  assertArtifactVersion,
  assertCompilerLoadsOnlyInWorker,
  assertRepositoryProfilingExcluded,
  assertWorkerUsesPinnedNativeCompiler,
} from "./artifact-boundary.ts";

const BUILT_CLI_PATH = ".vite-plus/build/cli.js";

const worker = await lstat(
  ".vite-plus/build/inspection/analysis-process-entry.js"
);

assert.equal(
  worker.isFile(),
  true,
  "The built analysis process entry must be a regular file."
);

assert.equal(
  worker.isSymbolicLink(),
  false,
  "The built analysis process entry must not be a symlink."
);

await assertRepositoryProfilingExcluded(".vite-plus/build");

await assertWorkerUsesPinnedNativeCompiler(BUILT_CLI_PATH);

const packageVersion = decodeJson(
  Schema.Struct({
    version: Schema.mutableKey(Schema.String),
  }),
  await readFile("package.json", "utf-8")
).version;

await assertArtifactVersion(BUILT_CLI_PATH, packageVersion);

const cli = await runCommand(
  process.execPath,
  [
    BUILT_CLI_PATH,
    "signatures",
    "execa",
    "execa",
    "--workspace",
    ".",
    "--json",
  ],
  { reject: false, trimFinalNewline: false }
);

assert.equal(cli.exitCode, 0, cli.stderr || cli.stdout);

assert.equal(cli.stderr, "");

const cliOutcome = decodeJson(
  Schema.Struct({
    result: Schema.mutableKey(
      Schema.Struct({
        intent: Schema.mutableKey(Schema.String),
        moduleExport: Schema.mutableKey(
          Schema.Struct({
            name: Schema.mutableKey(Schema.String),
            signatures: Schema.mutableKey(
              Schema.mutable(
                Schema.Array(
                  Schema.Struct({
                    kind: Schema.mutableKey(Schema.String),
                    text: Schema.mutableKey(Schema.String),
                  })
                )
              )
            ),
          })
        ),
      })
    ),
    status: Schema.mutableKey(Schema.String),
  }),
  cli.stdout
);

assert.equal(cliOutcome.status, "success");

assert.equal(cliOutcome.result.intent, "signature-inspection");

assert.equal(cliOutcome.result.moduleExport.name, "execa");

assert.equal(cliOutcome.result.moduleExport.signatures.length, 4);

assert.match(
  cliOutcome.result.moduleExport.signatures[0]?.text ?? "",
  /^<NewOptionsType/u
);

const protocolCli = await runCommand(
  process.execPath,
  [BUILT_CLI_PATH, "protocol"],
  {
    input: JSON.stringify({
      intent: "signature-inspection",
      protocolVersion: "1",
      request: {
        exportName: "execa",
        resolutionContext: nodePath.resolve("."),
        specifier: "execa",
      },
    }),
    reject: false,
    trimFinalNewline: false,
  }
);

assert.equal(protocolCli.exitCode, 0, protocolCli.stderr || protocolCli.stdout);

assert.equal(protocolCli.stderr, "");

const protocolResponse = decodeJson(
  Schema.Struct({
    outcome: Schema.mutableKey(
      Schema.Struct({
        status: Schema.mutableKey(Schema.String),
      })
    ),
    projection: Schema.mutableKey(
      Schema.optionalKey(
        Schema.Struct({
          signatureEvidence: Schema.mutableKey(
            Schema.optionalKey(Schema.String)
          ),
        })
      )
    ),
    protocolVersion: Schema.mutableKey(Schema.String),
  }),
  protocolCli.stdout
);

assert.equal(protocolResponse.protocolVersion, "1");

assert.equal(protocolResponse.projection?.signatureEvidence, "structured");

assert.equal(protocolResponse.outcome.status, "success");

await assertArtifactCacheReuse(BUILT_CLI_PATH);

await assertCompilerLoadsOnlyInWorker(BUILT_CLI_PATH);
