#!/usr/bin/env node
import { runMain } from "@effect/platform-bun/BunRuntime";
import { Effect } from "effect";

import { launchNative } from "#typepeek/distribution/native-launcher";
import { processLayer } from "#typepeek/platform/process-runtime";

runMain(
  Effect.scoped(
    Effect.gen(function* launch() {
      const cliArguments = process.argv.slice(2);

      if (yield* launchNative(import.meta.url, cliArguments)) {
        return;
      }

      const { runCli } = yield* Effect.promise(
        async () => await import("#typepeek/cli/cli-runtime")
      );

      yield* runCli(cliArguments);
    })
  ).pipe(Effect.provide(processLayer))
);
