import { execa } from "execa";
import assert from "node:assert/strict";

import { decodeDiscoveryRun, evaluateDiscoveryRun } from "../benchmarks/discovery/report.ts";

const result = await execa(process.execPath, [
  "benchmarks/discovery/run.ts",
  "--iterations",
  "2",
  "--warmups",
  "0",
  "--json",
]);
const run = decodeDiscoveryRun(JSON.parse(result.stdout));
assert.equal(run.identity.adapter, "package");
assert.equal(run.evidenceUnchanged, true);
assert.equal(run.inputsUnchanged, true);
assert.deepEqual(run.workloads, [
  "execa-command",
  "execa-cancellation",
  "execa-invocation",
  "execa-errors",
  "execa-absent",
  "node-read-file",
  "node-exists",
  "effect-option",
  "stricli-routes",
  "typescript-program",
]);
assert.equal(run.rows.length, 35);
assert.equal(run.rows.flatMap((row) => row.samples).length, 70);
assert.ok(
  run.rows
    .filter((row) => row.workload === "execa-command")
    .every((row) => row.expectedFacts.includes("call:( command : string ) : string [ ]")),
);
assert.equal(evaluateDiscoveryRun(run).correctness, true);
assert.equal(evaluateDiscoveryRun(run).stable, false);
console.log(
  "Prepacked discovery smoke passed: ten workloads and all applicable methods returned correct evidence.",
);
