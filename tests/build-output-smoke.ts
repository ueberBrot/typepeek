import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertArtifactCacheReuse,
  assertRepositoryProfilingExcluded,
} from "./artifact-boundary.ts";

const worker = await lstat(".vite-plus/build/inspection/analysis-process-entry.js");
assert.equal(worker.isFile(), true, "The built analysis process entry must be a regular file.");
assert.equal(
  worker.isSymbolicLink(),
  false,
  "The built analysis process entry must not be a symlink.",
);
await assertRepositoryProfilingExcluded(".vite-plus/build");

const packageVersion = (
  JSON.parse(await readFile("package.json", "utf8")) as { readonly version: string }
).version;
const versionCli = spawnSync(process.execPath, [".vite-plus/build/cli.js", "--version"], {
  encoding: "utf8",
});
assert.equal(versionCli.status, 0, versionCli.stderr);
assert.equal(versionCli.stdout, `${packageVersion}\n`);

const cli = spawnSync(
  process.execPath,
  [".vite-plus/build/cli.js", "signatures", "execa", "execa", "--context", ".", "--json"],
  { encoding: "utf8" },
);
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.equal(cli.stderr, "");
const cliOutcome = JSON.parse(cli.stdout) as {
  readonly status: string;
  readonly result: {
    readonly intent: string;
    readonly moduleExport: {
      readonly name: string;
      readonly signatures: readonly { readonly kind: string; readonly text: string }[];
    };
  };
};
assert.equal(cliOutcome.status, "success");
assert.equal(cliOutcome.result.intent, "signature-inspection");
assert.equal(cliOutcome.result.moduleExport.name, "execa");
assert.equal(cliOutcome.result.moduleExport.signatures.length, 4);
assert.match(cliOutcome.result.moduleExport.signatures[0]?.text ?? "", /^<NewOptionsType/u);

const protocolCli = spawnSync(process.execPath, [".vite-plus/build/cli.js", "protocol"], {
  encoding: "utf8",
  input: JSON.stringify({
    protocolVersion: "1",
    intent: "signature-inspection",
    request: {
      resolutionContext: resolve("."),
      specifier: "execa",
      exportName: "execa",
    },
  }),
});
assert.equal(protocolCli.status, 0, protocolCli.stderr || protocolCli.stdout);
assert.equal(protocolCli.stderr, "");
const protocolResponse = JSON.parse(protocolCli.stdout) as {
  readonly protocolVersion: string;
  readonly projection?: { readonly signatureEvidence?: string };
  readonly outcome: { readonly status: string };
};
assert.equal(protocolResponse.protocolVersion, "1");
assert.equal(protocolResponse.projection?.signatureEvidence, "structured");
assert.equal(protocolResponse.outcome.status, "success");
await assertArtifactCacheReuse(".vite-plus/build/cli.js");

const inspectionApiPath = "../.vite-plus/build/inspection-api.js";
const inspectionApi = (await import(inspectionApiPath)) as {
  readonly inspectExportSignatures: (request: {
    readonly resolutionContext: string;
    readonly specifier: string;
    readonly exportName: string;
  }) => Promise<unknown>;
  readonly inspectPlan: (request: {
    readonly resolutionContext: string;
    readonly specifier: string;
    readonly queries: readonly { readonly intent: "interface-overview" }[];
  }) => Promise<unknown>;
  readonly inspectExportSearch: unknown;
  readonly inspectPublicSubpaths: unknown;
  readonly inspectCapabilities: unknown;
  readonly inspectionCapabilitiesSchema: unknown;
  readonly comparePublicInterfaces: unknown;
  readonly invokeInspectionProtocol: unknown;
};
const outcome = await inspectionApi.inspectExportSignatures({
  resolutionContext: resolve("."),
  specifier: "execa",
  exportName: "execa",
});
assert.deepEqual(outcome, cliOutcome);
const planOutcome = await inspectionApi.inspectPlan({
  resolutionContext: resolve("."),
  specifier: "execa",
  queries: [{ intent: "interface-overview" }],
});
assert.equal(
  (planOutcome as { readonly status?: unknown }).status,
  "success",
  JSON.stringify(planOutcome),
);
assert.equal(typeof inspectionApi.inspectExportSearch, "function");
assert.equal(typeof inspectionApi.inspectPublicSubpaths, "function");
assert.equal(typeof inspectionApi.inspectCapabilities, "function");
assert.equal(typeof inspectionApi.inspectionCapabilitiesSchema, "function");
assert.equal(typeof inspectionApi.comparePublicInterfaces, "function");
assert.equal(typeof inspectionApi.invokeInspectionProtocol, "function");
