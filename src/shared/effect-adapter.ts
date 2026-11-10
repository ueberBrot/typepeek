import { Cause, Effect, Exit } from "effect";

/** Preserves original failures when a Promise-based integration invokes an Effect. */
export const runAdapterEffect = async <Value, E>(
  effect: Effect.Effect<Value, E>
): Promise<Value> => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }

  return exit.value;
};
