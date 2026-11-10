import { Effect } from "effect";

/** Packaged builds disable profiling. */
export const inspectionProfilingEnabled = false;

export const beginInspectionProfile = function beginInspectionProfile(): void {
  /* Release builds omit profiling. */
};

export const profileInspectionPhase = function profileInspectionPhase<Value>(
  _name: string,
  inspect: () => Value
): Value {
  return inspect();
};

export const completeInspectionProfile =
  function completeInspectionProfile(): undefined {
    return undefined;
  };

export const forwardInspectionProfile = (_serialized: Uint8Array) =>
  Effect.void;

export const profileInspectionEffect = <Value, E, R>(
  _name: string,
  inspect: Effect.Effect<Value, E, R>
): Effect.Effect<Value, E, R> => inspect;
