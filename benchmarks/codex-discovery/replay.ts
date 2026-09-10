import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { inspectWithCompiler } from "../discovery/compiler.ts";
import { selectDiscoveryWorkloads } from "../discovery/workloads.ts";
import {
  decodeAcquisitionOracle,
  decodeTimedCodexEvents,
  measureAcquisition,
} from "./acquisition.ts";

const { values } = parseArgs({
  options: {
    trace: { type: "string" },
    oracle: { type: "string" },
    workspace: { type: "string" },
    case: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.trace || !values.output || (!values.oracle && !(values.workspace && values.case))) {
  throw new Error(
    "Usage: node benchmarks/codex-discovery/replay.ts --trace events.timed.jsonl --oracle oracle.json --output acquisition.json",
  );
}
if (values.oracle && (values.workspace || values.case))
  throw new Error("Use either --oracle or --workspace with --case.");
const workload = values.case === undefined ? undefined : selectDiscoveryWorkloads(values.case)[0]!;
const compiler =
  workload === undefined ? undefined : inspectWithCompiler(values.workspace!, workload);
const oracle = decodeAcquisitionOracle(
  values.oracle === undefined
    ? {
        schemaVersion: 1,
        workload,
        facts: compiler!.facts,
        declarations: compiler!.declarations,
        exportDeclarations: compiler!.exportDeclarations,
      }
    : JSON.parse(await readFile(values.oracle, "utf8")),
);
const events = decodeTimedCodexEvents(await readFile(values.trace, "utf8"));
const result = measureAcquisition(oracle, events);
const serialized = `${JSON.stringify(result, null, 2)}\n`;
await writeFile(values.output, serialized, { flag: "wx" });
process.stdout.write(serialized);
