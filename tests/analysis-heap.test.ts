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
  it.each([
    { allocate: false, diagnostic: "available" },
    { allocate: true, diagnostic: "available" },
    { allocate: true, diagnostic: "failed" },
    { allocate: true, diagnostic: "blocked" },
  ] as const)(
    "bounds the Bun worker heap with allocation=$allocate and stderr=$diagnostic",
    async ({ allocate, diagnostic }) => {
      const fixture = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-analysis-heap-")
      );

      try {
        const entry = nodePath.join(fixture, "entry.mjs");
        await writeFile(
          entry,
          `import { Effect, Sink, Stdio } from ${JSON.stringify(import.meta.resolve("effect"))};
import { systemError } from ${JSON.stringify(import.meta.resolve("effect/PlatformError"))};
import { layer } from ${JSON.stringify(import.meta.resolve("@effect/platform-node-shared/NodeStdio"))};
import { installAnalysisHeapLimit } from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const diagnostic = ${JSON.stringify(diagnostic)};
  const stderr = diagnostic === "available" ? stdio.stderr : () => diagnostic === "failed"
    ? Sink.fail(systemError({ _tag: "Unknown", module: "Stdio", method: "stderr", cause: new Error("Closed diagnostic stream.") }))
    : Sink.fromEffect(Effect.never);
  yield* installAnalysisHeapLimit().pipe(Effect.provideService(Stdio.Stdio, Stdio.make({ ...stdio, stderr })));
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
          allocate && diagnostic === "available"
            ? "Typepeek analysis heap limit exceeded."
            : ""
        );
        expect(result.stdout).toBe(allocate ? "" : "completed");
      } finally {
        await rm(fixture, { force: true, recursive: true });
      }
    }
  );
});
