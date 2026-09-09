import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertArtifactCacheReuse,
  assertCompilerLoadsOnlyInWorker,
  assertRepositoryProfilingExcluded,
  assertWorkerUsesCommonJsCompiler,
} from "./artifact-boundary.ts";

await assertRepositoryProfilingExcluded("dist");
assertWorkerUsesCommonJsCompiler("dist/cli.js");

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
  /Use overview or search to find exports/u,
  /signatures\s+Show every public call and construct signature of an export/u,
  /plan\s+Run several queries against the same installed evidence/u,
  /search\s+Find export names containing a case-insensitive substring/u,
  /subpaths\s+List public subpaths exposed by the package manifest/u,
  /compare\s+Compare export names and public subpaths in two complete indexes/u,
  /capabilities\s+List supported protocol requests and limits as JSON/u,
  /protocol\s+Invoke the Inspection Protocol/u,
]) {
  assert.match(cli.stdout, expected);
}

const protocolCli = spawnSync(process.execPath, ["dist/cli.js", "protocol"], {
  encoding: "utf8",
  input: JSON.stringify({
    protocolVersion: "1",
    intent: "signature-inspection",
    response: { signatureEvidence: "both" },
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
const execaSignatures = (
  JSON.parse(protocolCli.stdout) as {
    readonly outcome: {
      readonly result: {
        readonly moduleExport: {
          readonly signatures: ReadonlyArray<{
            readonly text: string;
            readonly parameters: ReadonlyArray<{ readonly type: string }>;
          }>;
        };
      };
    };
  }
).outcome.result.moduleExport.signatures;
assert.equal(execaSignatures[2]?.parameters[0]?.type, "string | URL");
assert.equal(
  execaSignatures[1]?.parameters[0]?.type,
  "readonly [TemplateStringsArray, ...TemplateExpression[]]",
);
assert.equal(
  execaSignatures[1]?.text,
  "(templateString_0: TemplateStringsArray, ...templateString: TemplateExpression[]): ResultPromise<{}>",
);
await assertArtifactCacheReuse("dist/cli.js");

const signatureConsumer = await mkdtemp(join(tmpdir(), "typepeek-signature-consumer-"));
try {
  const installedPackage = join(signatureConsumer, "node_modules", "array-signatures");
  await mkdir(installedPackage, { recursive: true });
  await writeFile(join(signatureConsumer, "package.json"), '{"type":"module"}');
  await writeFile(
    join(installedPackage, "package.json"),
    '{"name":"array-signatures","version":"1.0.0","types":"index.d.ts"}',
  );
  await writeFile(
    join(installedPackage, "index.d.ts"),
    "export declare function split(command: string): string[];\n",
  );
  const signatures = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "signatures",
      "array-signatures",
      "split",
      "--workspace",
      signatureConsumer,
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, TYPEPEEK_CACHE_BYPASS: "1" } },
  );
  assert.equal(signatures.status, 0, signatures.stderr || signatures.stdout);
  const outcome = JSON.parse(signatures.stdout) as {
    readonly result: {
      readonly moduleExport: {
        readonly signatures: ReadonlyArray<{ readonly returns: { readonly type: string } }>;
      };
    };
  };
  assert.equal(outcome.result.moduleExport.signatures[0]?.returns.type, "string[]");
} finally {
  await rm(signatureConsumer, { recursive: true, force: true });
}

assertCompilerLoadsOnlyInWorker("dist/cli.js");
