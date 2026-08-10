import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const cli = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
  encoding: "utf8",
});

assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /typepeek/u);
assert.match(
  cli.stdout,
  /Describe the TypeScript-visible Public Interface of Inspectable Modules\./u,
);
