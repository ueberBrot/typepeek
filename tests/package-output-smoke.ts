import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { stripVTControlCharacters } from "node:util";

import { Schema } from "effect";

import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import {
  assertArtifactCacheReuse,
  assertArtifactVersion,
  assertRuntimeImportBoundaries,
  assertRepositoryProfilingExcluded,
  assertWorkerUsesPinnedNativeCompiler,
} from "./artifact-boundary.ts";

const PACKAGED_CLI_PATH = "dist/cli.js";
const PACKAGE_MANIFEST_FILE = "package.json";
const SIGNATURE_PACKAGE = "array-signatures";

await assertRepositoryProfilingExcluded("dist");

await assertWorkerUsesPinnedNativeCompiler(PACKAGED_CLI_PATH);

const npmCache = await mkdtemp(nodePath.join(tmpdir(), "typepeek-npm-cache-"));

try {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  const packageDryRun = await runCommand(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
      reject: false,
      trimFinalNewline: false,
    }
  );

  assert.equal(packageDryRun.exitCode, 0, packageDryRun.stderr);

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

await assertArtifactVersion(PACKAGED_CLI_PATH, packageVersion);

const cli = await runCommand(process.execPath, [PACKAGED_CLI_PATH, "--help"], {
  reject: false,
  trimFinalNewline: false,
});

assert.equal(cli.exitCode, 0, cli.stderr);

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
  assert.match(stripVTControlCharacters(cli.stdout), expected);
}

const protocolCli = await runCommand(
  process.execPath,
  [PACKAGED_CLI_PATH, "protocol"],
  {
    input: JSON.stringify({
      intent: "signature-inspection",
      protocolVersion: "1",
      request: {
        exportName: "parse",
        resolutionContext: process.cwd(),
        specifier: "semver",
      },
      response: { signatureEvidence: "both" },
    }),
    reject: false,
    trimFinalNewline: false,
  }
);

assert.equal(protocolCli.exitCode, 0, protocolCli.stderr || protocolCli.stdout);

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

const signatureResponseSchema = Schema.Struct({
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
});

const parseSignatures = decodeJson(signatureResponseSchema, protocolCli.stdout)
  .outcome.result.moduleExport.signatures;

assert.equal(parseSignatures.length, 3);

assert.equal(
  parseSignatures[0]?.parameters[0]?.type,
  "string | SemVer | null | undefined"
);

assert.equal(
  parseSignatures[1]?.parameters[1]?.type,
  "boolean | semver.Options"
);

assert.equal(
  parseSignatures[1]?.text,
  "(version: string | SemVer | null | undefined, optionsOrLoose: boolean | semver.Options, throwErrors: true): SemVer"
);

await assertArtifactCacheReuse(PACKAGED_CLI_PATH);

const signatureConsumer = await mkdtemp(
  nodePath.join(tmpdir(), "typepeek-signature-consumer-")
);

try {
  const installedPackage = nodePath.join(
    signatureConsumer,
    "node_modules",
    SIGNATURE_PACKAGE
  );

  await mkdir(installedPackage, { recursive: true });
  await writeFile(
    nodePath.join(signatureConsumer, PACKAGE_MANIFEST_FILE),
    '{"type":"module"}'
  );
  await writeFile(
    nodePath.join(installedPackage, PACKAGE_MANIFEST_FILE),
    JSON.stringify({
      name: SIGNATURE_PACKAGE,
      types: "index.d.ts",
      version: "1.0.0",
    })
  );
  await writeFile(
    nodePath.join(installedPackage, "index.d.ts"),
    [
      "export declare function split(command: string): string[];",
      "type TemplateExpression = string | number;",
      "type TemplateString = readonly [TemplateStringsArray, ...readonly TemplateExpression[]];",
      "export declare const tag: (...templateString: TemplateString) => Promise<string>;",
    ].join("\n")
  );

  const signatures = await runCommand(
    process.execPath,
    [
      nodePath.resolve(PACKAGED_CLI_PATH),
      "signatures",
      SIGNATURE_PACKAGE,
      "split",
      "--workspace",
      signatureConsumer,
      "--json",
    ],
    {
      env: { ...process.env, TYPEPEEK_CACHE_BYPASS: "1" },
      reject: false,
      trimFinalNewline: false,
    }
  );

  assert.equal(signatures.exitCode, 0, signatures.stderr || signatures.stdout);

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

  const template = await runCommand(
    process.execPath,
    [nodePath.resolve(PACKAGED_CLI_PATH), "protocol"],
    {
      input: JSON.stringify({
        intent: "signature-inspection",
        protocolVersion: "1",
        request: {
          exportName: "tag",
          resolutionContext: signatureConsumer,
          specifier: SIGNATURE_PACKAGE,
        },
        response: { signatureEvidence: "both" },
      }),
    }
  );

  const [signature] = decodeJson(signatureResponseSchema, template.stdout)
    .outcome.result.moduleExport.signatures;

  assert.equal(
    signature?.parameters[0]?.type,
    "readonly [TemplateStringsArray, ...TemplateExpression[]]"
  );
  assert.equal(
    signature?.text,
    "(templateString_0: TemplateStringsArray, ...templateString: TemplateExpression[]): Promise<string>"
  );
} finally {
  await rm(signatureConsumer, { force: true, recursive: true });
}

await assertRuntimeImportBoundaries(PACKAGED_CLI_PATH);
