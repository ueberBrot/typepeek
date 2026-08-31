import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertArtifactCacheReuse,
  assertRepositoryProfilingExcluded,
} from "./artifact-boundary.ts";

await assertRepositoryProfilingExcluded("dist");

const npmCache = await mkdtemp(join(tmpdir(), "typepeek-npm-cache-"));
try {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const packageDryRun = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });
  assert.equal(packageDryRun.status, 0, packageDryRun.stderr);

  const [packageManifest] = JSON.parse(packageDryRun.stdout) as [
    { readonly files: ReadonlyArray<{ readonly path: string }> },
  ];
  const packagedPaths = new Set(packageManifest.files.map(({ path }) => path));
  for (const expectedPath of [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "assets/typepeek-logo.svg",
    "package.json",
  ] as const) {
    assert.ok(packagedPaths.has(expectedPath), `${expectedPath} is missing from the npm package`);
  }
  for (const packagedPath of packagedPaths) {
    if (!packagedPath.startsWith("dist/")) continue;
    assert.ok(packagedPath.endsWith(".js"), `${packagedPath} is not a required runtime artifact`);
  }
  assert.equal(
    packagedPaths.has("dist/inspection-api.js"),
    false,
    "The retired JavaScript library entrypoint must not ship",
  );
} finally {
  await rm(npmCache, { force: true, recursive: true });
}

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
  /Start with overview to discover exports/u,
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
      specifier: "execa",
      exportName: "execa",
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
