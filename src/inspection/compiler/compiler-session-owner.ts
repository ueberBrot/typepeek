import { Cause, Effect, Exit } from "effect";
import { forEach as forEachEffect } from "effect/Effect";

import { runAdapterEffect } from "#typepeek/shared/effect-adapter";

export interface CompilerResource {
  readonly close: () => Promise<void>;
}

export interface CompilerSessionOwner {
  readonly retain: (resource: CompilerResource) => void;
  readonly release: (resource: CompilerResource) => void;
  readonly close: () => Promise<void>;
  readonly closeEffect: Effect.Effect<void>;
}

export const createCompilerSessionOwner = (): CompilerSessionOwner => {
  const resources = new Set<CompilerResource>();
  let closed = false;

  const closeResources = Effect.gen(function* closeCompilerResources() {
    closed = true;
    const pending = [...resources];
    resources.clear();

    const results = yield* forEachEffect(
      pending,
      (resource) =>
        Effect.exit(
          Effect.promise(async () => {
            await resource.close();
          })
        ),
      { concurrency: "unbounded" }
    );

    const failures = results
      .filter(Exit.isFailure)
      .map((exit) => Cause.squash(exit.cause));

    if (failures.length > 0) {
      return yield* Effect.die(
        new AggregateError(failures, "Compiler resources could not be closed.")
      );
    }

    return yield* Effect.void;
  });

  const closeEffect = Effect.runSync(
    Effect.cached(Effect.uninterruptible(closeResources))
  );

  return {
    close: async () => {
      await runAdapterEffect(closeEffect);
    },
    closeEffect,
    release: (resource) => {
      resources.delete(resource);
    },
    retain: (resource) => {
      if (closed) {
        throw new Error("Compiler session owner is closed.");
      }

      resources.add(resource);
    },
  };
};
