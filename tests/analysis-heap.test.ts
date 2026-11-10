import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";

const moduleUrl = new URL(
  "../src/inspection/execution/analysis-heap.ts",
  import.meta.url
).href;

describe("Bun analysis heap", () => {
  it.each([false, true])(
    "bounds the Bun worker heap without keeping an idle worker alive: %s",
    async (allocate) => {
      const fixture = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-analysis-heap-")
      );

      try {
        const entry = nodePath.join(fixture, "entry.mjs");
        await writeFile(
          entry,
          `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { layer } from ${JSON.stringify(import.meta.resolve("@effect/platform-node-shared/NodeStdio"))};
import { installAnalysisHeapLimit } from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  yield* installAnalysisHeapLimit();
  yield* Effect.promise(async () => {
if (${JSON.stringify(allocate)}) {
  const retained = [];
  for (let index = 0; index < 128; index += 1) {
    retained.push(new Array(131072).fill(index));
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
console.log("completed");
  });
})).pipe(Effect.provide(layer)));
`
        );

        const result = await runCommand("bun", [entry], {
          env: { TYPEPEEK_ANALYSIS_HEAP_MEGABYTES: "32" },
          reject: false,
          timeout: 10_000,
        });

        expect(result.timedOut).toBeFalsy();
        expect(result.exitCode).toBe(allocate ? 1 : 0);
        expect(result.stderr).toBe(
          allocate ? "Typepeek analysis heap limit exceeded." : ""
        );
        expect(result.stdout).toBe(allocate ? "" : "completed");
      } finally {
        await rm(fixture, { force: true, recursive: true });
      }
    }
  );
});
