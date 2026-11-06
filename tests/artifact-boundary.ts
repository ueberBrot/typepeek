import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

const SMOKE_PACKAGE = "semver";

export const assertArtifactVersion = async (
  cliPath: string,
  version: string
): Promise<void> => {
  const result = await runCommand(process.execPath, [cliPath, "--version"], {
    reject: false,
    trimFinalNewline: false,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
};

/** The parent must run a real inspection without loading the worker's compiler. */
export const assertCompilerLoadsOnlyInWorker =
  async function assertCompilerLoadsOnlyInWorker(
    cliPath: string
  ): Promise<void> {
    const hook = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'tsrs/sync' || specifier === 'tsrs/async') throw new Error('Compiler SDK loaded in CLI parent');
  return nextResolve(specifier, context);
} });`;

    const result = await runCommand(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(hook)}`,
        cliPath,
        "signatures",
        SMOKE_PACKAGE,
        "parse",
        "--json",
      ],
      {
        env: { ...process.env, TYPEPEEK_CACHE_BYPASS: "1" },
        reject: false,
        trimFinalNewline: false,
      }
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(
      decodeJson(
        Schema.Struct({
          status: Schema.mutableKey(Schema.String),
        }),
        result.stdout
      ).status,
      "success"
    );
  };

/** The worker must use its pinned native SDK even when an environment override is present. */
export const assertWorkerUsesPinnedNativeCompiler =
  async function assertWorkerUsesPinnedNativeCompiler(
    cliPath: string
  ): Promise<void> {
    const hook = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@typescript/typescript6' || specifier === 'typescript') {
    throw new Error('Legacy compiler loaded by the native worker');
  }
  return nextResolve(specifier, context);
} });`;

    const result = await runCommand(
      process.execPath,
      [cliPath, "signatures", SMOKE_PACKAGE, "parse", "--json"],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}`,
          TSRS_BINARY: nodePath.join(
            tmpdir(),
            "__typepeek_forbidden_compiler_override__"
          ),
          TYPEPEEK_CACHE_BYPASS: "1",
        },
        reject: false,
        trimFinalNewline: false,
      }
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(
      decodeJson(
        Schema.Struct({
          status: Schema.mutableKey(Schema.String),
        }),
        result.stdout
      ).status,
      "success"
    );
  };

/** Verifies that repository-only phase tracing is absent from every shipped JavaScript file. */
export const assertRepositoryProfilingExcluded =
  async function assertRepositoryProfilingExcluded(
    directory: string
  ): Promise<void> {
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });

    const sources = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map(
          async (entry) =>
            await readFile(
              nodePath.resolve(entry.parentPath, entry.name),
              "utf-8"
            )
        )
    );

    assert.doesNotMatch(
      sources.join("\n"),
      /TYPEPEEK_PROFILE|inspection-profile|node:perf_hooks/u,
      `Repository profiling diagnostics must not ship in ${directory}.`
    );
  };

const assertInspectionCacheReuse = async function assertInspectionCacheReuse(
  cliArguments: readonly string[]
): Promise<void> {
  const cacheDirectory = await mkdtemp(
    nodePath.join(tmpdir(), "typepeek-artifact-cache-")
  );

  const env = { ...process.env, TYPEPEEK_CACHE_DIRECTORY: cacheDirectory };

  try {
    const first = await runCommand(process.execPath, cliArguments, {
      env,
      reject: false,
      trimFinalNewline: false,
    });

    assert.equal(first.exitCode, 0, first.stderr || first.stdout);

    const readdirResult = await readdir(cacheDirectory);

    const entryNames = readdirResult.filter((name) => name.endsWith(".json"));

    assert.equal(
      entryNames.length,
      1,
      "The first artifact inspection must create one cache entry."
    );

    const entryPath = nodePath.join(
      cacheDirectory,
      requireDefined(entryNames[0])
    );

    const before = await lstat(entryPath, { bigint: true });

    const repeated = await runCommand(process.execPath, cliArguments, {
      env,
      reject: false,
      trimFinalNewline: false,
    });

    assert.equal(repeated.exitCode, 0, repeated.stderr || repeated.stdout);
    assert.equal(repeated.stdout, first.stdout);
    const after = await lstat(entryPath, { bigint: true });
    assert.equal(
      after.ino,
      before.ino,
      "A cache hit must not replace the stored entry."
    );
    assert.equal(
      after.mtimeNs,
      before.mtimeNs,
      "A cache hit must not rewrite the stored entry."
    );
  } finally {
    await rm(cacheDirectory, { force: true, recursive: true });
  }
};

/** Executes the shipped worker twice and proves the second run reuses one cache entry. */
export const assertArtifactCacheReuse = async function assertArtifactCacheReuse(
  cliPath: string
): Promise<void> {
  await Array.fromAsync(
    [
      ["overview", SMOKE_PACKAGE],
      ["signatures", "effect/Option", "getOrNull"],
      ["signatures", "semver", "parse"],
      ["signatures", "node:fs", "readFile"],
    ],
    async (cliArguments) => {
      await assertInspectionCacheReuse([
        cliPath,
        ...cliArguments,
        "--workspace",
        ".",
        "--json",
      ]);
    }
  );
};
