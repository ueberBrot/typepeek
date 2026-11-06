import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";

import { inspectWithCompiler } from "../support/compiler.ts";
import { selectDiscoveryWorkloads } from "../support/workloads.ts";
import { decodeAcquisitionOracle } from "./acquisition-evidence.ts";
import { decodeTimedCodexEvents, measureAcquisition } from "./acquisition.ts";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    oracle: { type: "string" },
    output: { type: "string" },
    trace: { type: "string" },
    workspace: { type: "string" },
  },
});

const USAGE =
  "Usage: node benchmarks/codex-discovery/replay.ts --trace events.timed.jsonl --oracle oracle.json --output acquisition.json";

if (
  values.trace === undefined ||
  values.trace === "" ||
  values.output === undefined ||
  values.output === ""
) {
  throw new Error(USAGE);
}

const hasOracle = (values.oracle ?? "") !== "";
const hasWorkspace = (values.workspace ?? "") !== "";
const hasCase = (values.case ?? "") !== "";

if (!hasOracle && !(hasWorkspace && hasCase)) {
  throw new Error(USAGE);
}

if (hasOracle && (hasWorkspace || hasCase)) {
  throw new Error("Use either --oracle or --workspace with --case.");
}

const workload =
  values.case === undefined
    ? undefined
    : requireDefined(selectDiscoveryWorkloads(values.case)[0]);

const compiler =
  workload === undefined
    ? undefined
    : inspectWithCompiler(requireDefined(values.workspace), workload);

const oracle = decodeAcquisitionOracle(
  values.oracle === undefined
    ? {
        declarations: requireDefined(compiler).declarations,
        exportDeclarations: requireDefined(compiler).exportDeclarations,
        facts: requireDefined(compiler).facts,
        schemaVersion: 1,
        workload,
      }
    : decodeJson(Schema.MutableJson, await readFile(values.oracle, "utf-8"))
);

const events = decodeTimedCodexEvents(await readFile(values.trace, "utf-8"));
const result = measureAcquisition(oracle, events);
const serialized = `${JSON.stringify(result, null, 2)}\n`;

await writeFile(values.output, serialized, { flag: "wx" });

process.stdout.write(serialized);
