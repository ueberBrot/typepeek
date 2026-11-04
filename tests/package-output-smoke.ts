import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";

import { decodeJson } from "#typepeek/json-data";

import {
  assertArtifactCacheReuse,
  assertCompilerLoadsOnlyInWorker,
  assertRepositoryProfilingExcluded,
  assertWorkerUsesCommonJsCompiler,
} from "./artifact-boundary.ts";

const PACKAGED_CLI_PATH = "dist/cli.js";
const PACKAGE_MANIFEST_FILE = "package.json";

await assertRepositoryProfilingExcluded("dist");

assertWorkerUsesCommonJsCompiler(PACKAGED_CLI_PATH);

const npmCache = await mkdtemp(nodePath.join(tmpdir(), "typepeek-npm-cache-"));

try {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  const packageDryRun = spawnSync(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      encoding: "utf-8",
      env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
    }
  );

  assert.equal(packageDryRun.status, 0, packageDryRun.stderr);

  const [packageManifest] = decodeJson(
    Schema.Tuple([
      Schema.Struct({
        files: Schema.mutableKey(
          Schema.mutable(
            Schema.Array(
              Schema.Struct({
                path: Schema.mutableKey(Schema.String),
              })
            )
          )
        ),
      }),
    ]),
    packageDryRun.stdout
  );

  const packagedPaths = new Set(packageManifest.files.map(({ path }) => path));

  for (const expectedPath of [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "assets/typepeek-logo.svg",
    PACKAGE_MANIFEST_FILE,
  ] as const) {
    assert.ok(
      packagedPaths.has(expectedPath),
      `${expectedPath} is missing from the npm package`
    );
  }

  for (const packagedPath of packagedPaths) {
    if (!packagedPath.startsWith("dist/")) {
      continue;
    }

    assert.ok(
      packagedPath.endsWith(".js"),
      `${packagedPath} is not a required runtime artifact`
    );
  }

  assert.equal(
    packagedPaths.has("dist/inspection-api.js"),
    false,
    "The retired JavaScript library entrypoint must not ship"
  );
} finally {
  await rm(npmCache, { force: true, recursive: true });
}

const packageVersion = decodeJson(
  Schema.Struct({
    version: Schema.mutableKey(Schema.String),
  }),
  await readFile(PACKAGE_MANIFEST_FILE, "utf-8")
).version;

const versionCli = spawnSync(
  process.execPath,
  [PACKAGED_CLI_PATH, "--version"],
  {
    encoding: "utf-8",
  }
);

assert.equal(versionCli.status, 0, versionCli.stderr);

assert.equal(versionCli.stdout, `${packageVersion}\n`);

const cli = spawnSync(process.execPath, [PACKAGED_CLI_PATH, "--help"], {
  encoding: "utf-8",
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

const protocolCli = spawnSync(
  process.execPath,
  [PACKAGED_CLI_PATH, "protocol"],
  {
    encoding: "utf-8",
    input: JSON.stringify({
      intent: "signature-inspection",
      protocolVersion: "1",
      request: {
        exportName: "execa",
        resolutionContext: process.cwd(),
        specifier: "execa",
      },
      response: { signatureEvidence: "both" },
    }),
  }
);

assert.equal(protocolCli.status, 0, protocolCli.stderr || protocolCli.stdout);

assert.equal(protocolCli.stderr, "");

assert.equal(
  decodeJson(
    Schema.Struct({
      protocolVersion: Schema.mutableKey(Schema.optionalKey(Schema.Unknown)),
    }),
    protocolCli.stdout
  ).protocolVersion,
  "1"
);

const execaSignatures = decodeJson(
  Schema.Struct({
    outcome: Schema.Struct({
      result: Schema.Struct({
        moduleExport: Schema.Struct({
          signatures: Schema.Array(
            Schema.Struct({
              parameters: Schema.Array(Schema.Struct({ type: Schema.String })),
              text: Schema.String,
            })
          ),
        }),
      }),
    }),
  }),
  protocolCli.stdout
).outcome.result.moduleExport.signatures;

assert.equal(execaSignatures[2]?.parameters[0]?.type, "string | URL");

assert.equal(
  execaSignatures[1]?.parameters[0]?.type,
  "readonly [TemplateStringsArray, ...TemplateExpression[]]"
);

assert.equal(
  execaSignatures[1]?.text,
  "(templateString_0: TemplateStringsArray, ...templateString: TemplateExpression[]): ResultPromise<{}>"
);

await assertArtifactCacheReuse(PACKAGED_CLI_PATH);

const signatureConsumer = await mkdtemp(
  nodePath.join(tmpdir(), "typepeek-signature-consumer-")
);

try {
  const installedPackage = nodePath.join(
    signatureConsumer,
    "node_modules",
    "array-signatures"
  );

  await mkdir(installedPackage, { recursive: true });
  await writeFile(
    nodePath.join(signatureConsumer, PACKAGE_MANIFEST_FILE),
    '{"type":"module"}'
  );
  await writeFile(
    nodePath.join(installedPackage, PACKAGE_MANIFEST_FILE),
    '{"name":"array-signatures","version":"1.0.0","types":"index.d.ts"}'
  );
  await writeFile(
    nodePath.join(installedPackage, "index.d.ts"),
    "export declare function split(command: string): string[];\n"
  );

  const signatures = spawnSync(
    process.execPath,
    [
      nodePath.resolve(PACKAGED_CLI_PATH),
      "signatures",
      "array-signatures",
      "split",
      "--workspace",
      signatureConsumer,
      "--json",
    ],
    { encoding: "utf-8", env: { ...process.env, TYPEPEEK_CACHE_BYPASS: "1" } }
  );

  assert.equal(signatures.status, 0, signatures.stderr || signatures.stdout);

  const outcome = decodeJson(
    Schema.Struct({
      result: Schema.mutableKey(
        Schema.Struct({
          moduleExport: Schema.mutableKey(
            Schema.Struct({
              signatures: Schema.mutableKey(
                Schema.mutable(
                  Schema.Array(
                    Schema.Struct({
                      returns: Schema.mutableKey(
                        Schema.Struct({
                          type: Schema.mutableKey(Schema.String),
                        })
                      ),
                    })
                  )
                )
              ),
            })
          ),
        })
      ),
    }),
    signatures.stdout
  );

  assert.equal(
    outcome.result.moduleExport.signatures[0]?.returns.type,
    "string[]"
  );
} finally {
  await rm(signatureConsumer, { force: true, recursive: true });
}

assertCompilerLoadsOnlyInWorker(PACKAGED_CLI_PATH);
