import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { prepareOutputDirectory } from "../support/output-directory.ts";
import { decodeTimedCodexEvents } from "./acquisition.ts";
import {
  comparisonObservationSchema,
  renderComparisonMatrix,
  summarizeComparisonMatrix,
} from "./comparison-matrix.ts";
import { measureTaskTiming } from "./task-timing.ts";

const studySchema = Schema.Struct({
  attempts: Schema.Array(comparisonObservationSchema),
  codexVersion: Schema.String,
  identity: Schema.Json,
  options: Schema.Struct({
    cases: Schema.Array(Schema.String),
    conditions: Schema.Array(Schema.String),
    efforts: Schema.Array(Schema.String),
    models: Schema.Array(Schema.String),
    repeats: Schema.Int,
    seed: Schema.Int,
  }),
  status: Schema.String,
});

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    summary: { type: "string" },
  },
});

if (values.summary === undefined || values.output === undefined) {
  throw new Error(
    "Usage: vp run benchmark:matrix --summary summary.json --output NEW_DIRECTORY"
  );
}

const source = nodePath.resolve(values.summary);
const serialized = await readFile(source, "utf-8");
const study = Schema.decodeSync(Schema.fromJsonString(studySchema))(serialized);
const output = nodePath.resolve(values.output);

await prepareOutputDirectory(output, "matrix");

const attempts = await Array.fromAsync(study.attempts, async (attempt) => {
  const directory = nodePath.join(
    nodePath.dirname(source),
    nodePath.basename(attempt.artifactDirectory)
  );

  const events = decodeTimedCodexEvents(
    await readFile(nodePath.join(directory, "events.timed.jsonl"), "utf-8")
  );

  return {
    ...attempt,
    artifactDirectory: directory,
    timing: measureTaskTiming(events),
  };
});

const matrix = summarizeComparisonMatrix(attempts, study.options.cases);

const data = {
  attempts,
  codexVersion: study.codexVersion,
  identity: study.identity,
  matrix,
  options: study.options,
  schemaVersion: 1,
  source: {
    path: source,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  },
  status: study.status,
};

const seconds = (value: number | null) => value?.toFixed(2) ?? "unknown";
const totals = matrix.overall;

const markdown = [
  "# Typepeek versus files-only",
  "",
  renderComparisonMatrix(matrix),
  "",
  `Successful with verified evidence: Typepeek ${totals.typepeek.successful}/${totals.typepeek.attempts}; files ${totals.files.successful}/${totals.files.attempts}.`,
  `All-attempt reported tokens: Typepeek ${totals.typepeek.reportedTokens ?? "unknown"}; files ${totals.files.reportedTokens ?? "unknown"}. Failures remain in these totals.`,
  "",
  "Mean timing on the same successful pairs:",
  "",
  "Metric | Files | Typepeek",
  "--- | ---: | ---:",
  `Complete task | ${seconds(totals.taskTime.files)} s | ${seconds(totals.taskTime.typepeek)} s`,
  `Tool round trips | ${seconds(totals.toolTime.files)} s | ${seconds(totals.toolTime.typepeek)} s`,
  `Outside tools | ${seconds(totals.outsideTools.files)} s | ${seconds(totals.outsideTools.typepeek)} s`,
  `Time to evidence | ${seconds(totals.evidenceTime.files)} s | ${seconds(totals.evidenceTime.typepeek)} s`,
  "",
  "Task time runs from submission through the final answer, excluding setup and cleanup. Overlapping tool calls count once. Outside-tool time includes model generation, provider latency and orchestration. Tokens are reported input plus output, including cached input, not billing estimates. Unknown measurements remain unknown.",
].join("\n");

await writeFile(
  nodePath.join(output, "matrix.json"),
  JSON.stringify(data, null, 2),
  {
    flag: "wx",
  }
);

await writeFile(nodePath.join(output, "matrix.md"), `${markdown}\n`, {
  flag: "wx",
});

process.stdout.write(`${markdown}\n`);
