import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

const worker = await lstat(".vite-plus/build/inspection/analysis-process-entry.js");
assert.equal(worker.isFile(), true, "The built analysis process entry must be a regular file.");
assert.equal(
  worker.isSymbolicLink(),
  false,
  "The built analysis process entry must not be a symlink.",
);

const cli = spawnSync(
  process.execPath,
  [".vite-plus/build/cli.js", "signatures", "arktype", "type", "--context", ".", "--json"],
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
assert.equal(cliOutcome.result.moduleExport.name, "type");
assert.equal(cliOutcome.result.moduleExport.signatures.length, 3);
assert.match(cliOutcome.result.moduleExport.signatures[0]?.text ?? "", /^<const def/u);

const inspectionApiPath = "../.vite-plus/build/inspection-api.js";
const inspectionApi = (await import(inspectionApiPath)) as {
  readonly inspectExportSignatures: (request: {
    readonly resolutionContext: string;
    readonly specifier: string;
    readonly exportName: string;
  }) => Promise<unknown>;
};
const outcome = await inspectionApi.inspectExportSignatures({
  resolutionContext: resolve("."),
  specifier: "arktype",
  exportName: "type",
});
assert.deepEqual(outcome, cliOutcome);
