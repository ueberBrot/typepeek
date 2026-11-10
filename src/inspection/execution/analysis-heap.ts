import { Config, Effect, Schema } from "effect";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/model/budget-policy";
import { exitImmediately, heapUsed } from "#typepeek/platform/runtime-process";
import { writeStderr } from "#typepeek/platform/stdio";

export const installAnalysisHeapLimit = Effect.fnUntraced(
  function* installAnalysisHeapLimit() {
    const megabytes = yield* Config.schema(
      Schema.Int.check(Schema.isGreaterThan(0)),
      "TYPEPEEK_ANALYSIS_HEAP_MEGABYTES"
    ).pipe(Config.withDefault(INSPECTION_BUDGET_POLICY.analysisHeapMegabytes));

    const limit = megabytes * 1024 * 1024;
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* monitorAnalysisHeap() {
          yield* Effect.sleep("10 millis");
          const used = yield* heapUsed;

          if (used > limit) {
            yield* writeStderr("Typepeek analysis heap limit exceeded.\n");

            return yield* exitImmediately(1);
          }

          return yield* Effect.void;
        })
      )
    );
  }
);
