import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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
