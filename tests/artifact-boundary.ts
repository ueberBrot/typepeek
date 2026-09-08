import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The parent must run a real inspection without loading the worker's compiler. */
export function assertCompilerLoadsOnlyInWorker(cliPath: string): void {
  const hook = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@typescript/typescript6') throw new Error('Compiler loaded in CLI parent');
  return nextResolve(specifier, context);
} });`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      cliPath,
      "signatures",
      "@stricli/core",
      "buildRouteMap",
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, TYPEPEEK_CACHE_BYPASS: "1" } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((JSON.parse(result.stdout) as { readonly status: string }).status, "success");
}

/** Verifies that repository-only phase tracing is absent from every shipped JavaScript file. */
export async function assertRepositoryProfilingExcluded(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => readFile(resolve(entry.parentPath, entry.name), "utf8")),
  );
  assert.doesNotMatch(
    sources.join("\n"),
    /TYPEPEEK_PROFILE|inspection-profile|node:perf_hooks/u,
    `Repository profiling diagnostics must not ship in ${directory}.`,
  );
}

/** Executes the shipped worker twice and proves the second run reuses one cache entry. */
export async function assertArtifactCacheReuse(cliPath: string): Promise<void> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-artifact-cache-"));
  const arguments_ = [cliPath, "overview", "@stricli/core", "--workspace", ".", "--json"];
  const env = { ...process.env, TYPEPEEK_CACHE_DIRECTORY: cacheDirectory };
  try {
    const first = spawnSync(process.execPath, arguments_, { encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const entryNames = (await readdir(cacheDirectory)).filter((name) => name.endsWith(".json"));
    assert.equal(
      entryNames.length,
      1,
      "The first artifact inspection must create one cache entry.",
    );
    const entryPath = join(cacheDirectory, entryNames[0] as string);
    const before = await lstat(entryPath, { bigint: true });

    const repeated = spawnSync(process.execPath, arguments_, { encoding: "utf8", env });
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.equal(repeated.stdout, first.stdout);
    const after = await lstat(entryPath, { bigint: true });
    assert.equal(after.ino, before.ino, "A cache hit must not replace the stored entry.");
    assert.equal(after.mtimeNs, before.mtimeNs, "A cache hit must not rewrite the stored entry.");
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}
