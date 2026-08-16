import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  assertArtifactCacheReuse,
  assertRepositoryProfilingExcluded,
} from "./artifact-boundary.ts";

const workerSource = await readFile("dist/inspection/analysis-process-entry.js", "utf8");
assert.doesNotMatch(
  workerSource,
  /from ["']arktype["']/u,
  "The packaged analysis worker must not load the outcome codec dependency.",
);
await assertRepositoryProfilingExcluded("dist");

const packageVersion = (
  JSON.parse(await readFile("package.json", "utf8")) as { readonly version: string }
).version;
const versionCli = spawnSync(process.execPath, ["dist/cli.js", "--version"], {
  encoding: "utf8",
});
assert.equal(versionCli.status, 0, versionCli.stderr);
assert.equal(versionCli.stdout, `${packageVersion}\n`);

const cli = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
  encoding: "utf8",
});

assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /typepeek/u);
assert.match(cli.stdout, /Use overview to discover exports/u);
assert.match(cli.stdout, /signatures\s+Inspect only the public call and construct signatures/u);
assert.match(cli.stdout, /plan\s+Execute a bounded query list/u);
assert.match(cli.stdout, /search\s+Search the bounded Module Export index/u);
assert.match(cli.stdout, /subpaths\s+Discover manifest Public Subpaths/u);
assert.match(cli.stdout, /compare\s+Compare two complete Interface Overview indexes/u);
assert.match(cli.stdout, /capabilities\s+Print the versioned Inspection Core capabilities/u);
await assertArtifactCacheReuse("dist/cli.js");
const inspectionApiPath = "../dist/inspection-api.js";
const inspectionApi: unknown = await import(inspectionApiPath);
if (typeof inspectionApi !== "object" || inspectionApi === null) {
  throw new TypeError("The packed Inspection Core entrypoint did not export a module object.");
}
assert.equal(typeof Reflect.get(inspectionApi, "inspectInterfaceOverview"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectExport"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectExportSignatures"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectPlan"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectExportSearch"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectPublicSubpaths"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "inspectCapabilities"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "comparePublicInterfaces"), "function");
assert.equal(typeof Reflect.get(inspectionApi, "invokeInspectionProtocol"), "function");
