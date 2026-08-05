import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const libraryUrl = pathToFileURL(resolve("dist/index.js")).href;
const libraryModule: unknown = await import(libraryUrl);

assert.equal(
  Object.getOwnPropertyDescriptor(libraryModule, "TYPEPEEK_PACKAGE_NAME")?.value,
  "typepeek",
);

const cli = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
  encoding: "utf8",
});

assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /typepeek/u);
assert.match(
  cli.stdout,
  /Describe the TypeScript-visible Public Interface of Inspectable Modules\./u,
);
