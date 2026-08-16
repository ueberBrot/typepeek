import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { assertRepositoryProfilingExcluded } from "./artifact-boundary.ts";

await assertRepositoryProfilingExcluded("dist");

const cli = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
  encoding: "utf8",
});

assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /typepeek/u);
assert.match(cli.stdout, /Use overview to discover exports/u);
assert.match(cli.stdout, /signatures\s+Inspect only the public call and construct signatures/u);
const inspectionApiPath = "../dist/inspection-api.js";
const inspectionApi: unknown = await import(inspectionApiPath);
if (typeof inspectionApi !== "object" || inspectionApi === null) {
  throw new TypeError("The packed Inspection Core entrypoint did not export a module object.");
}
assert.equal(typeof Reflect.get(inspectionApi, "inspectInterfaceOverview"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectExport"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectExportSignatures"), "function");
