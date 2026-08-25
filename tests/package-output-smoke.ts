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
for (const expected of [
  /typepeek/u,
  /Use overview to discover exports/u,
  /signatures\s+Inspect only the public call and construct signatures/u,
  /plan\s+Execute a bounded query list/u,
  /search\s+Search the bounded Module Export index/u,
  /subpaths\s+Discover manifest Public Subpaths/u,
  /compare\s+Compare two complete Interface Overview indexes/u,
  /capabilities\s+Print the Inspection Core capabilities/u,
  /protocol\s+Invoke the Inspection Protocol/u,
]) {
  assert.match(cli.stdout, expected);
}

const protocolCli = spawnSync(process.execPath, ["dist/cli.js", "protocol"], {
  encoding: "utf8",
  input: JSON.stringify({
    protocolVersion: "1",
    intent: "signature-inspection",
    request: {
      resolutionContext: process.cwd(),
      specifier: "arktype",
      exportName: "type",
    },
  }),
});
assert.equal(protocolCli.status, 0, protocolCli.stderr || protocolCli.stdout);
assert.equal(protocolCli.stderr, "");
assert.equal(
  (JSON.parse(protocolCli.stdout) as { readonly protocolVersion?: unknown }).protocolVersion,
  "1",
);
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
