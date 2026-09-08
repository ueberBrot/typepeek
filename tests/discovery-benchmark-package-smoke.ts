import { execa } from "execa";
import assert from "node:assert/strict";

import { decodeDiscoveryRun, evaluateDiscoveryRun } from "../benchmarks/discovery/report.ts";

// Run only after a separate packaging step. This smoke check never builds the CLI.
const result = await execa(process.execPath, [
  "benchmarks/discovery/run.ts",
  "--case",
  "execa-command",
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
assert.deepEqual(
  run.rows.map((row) => row.condition),
  ["files", "compiler", "typepeek-cold", "typepeek-warm"],
);
assert.equal(run.rows.flatMap((row) => row.samples).length, 8);
assert.ok(
  run.rows.every((row) => row.expectedFacts.includes("call:( command : string ) : string [ ]")),
);
assert.equal(evaluateDiscoveryRun(run).correctness, true);
assert.equal(evaluateDiscoveryRun(run).stable, false);
console.log(
  "Prepacked discovery smoke passed: all four process boundaries returned correct evidence.",
);
