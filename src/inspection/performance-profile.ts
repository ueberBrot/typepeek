import { performance } from "node:perf_hooks";

const PROFILE_ENVIRONMENT_NAME = "TYPEPEEK_PROFILE";
const PROFILE_SCHEMA_VERSION = 1;

export interface InspectionProfilePhase {
  readonly name: string;
  readonly milliseconds: number;
}

export interface InspectionProfile {
  readonly kind: "inspection-profile";
  readonly schemaVersion: 1;
  readonly phases: readonly InspectionProfilePhase[];
}

let phases: InspectionProfilePhase[] | undefined;

/** Starts one opt-in, process-local profile that never enters an Inspection Result. */
export function beginInspectionProfile(): void {
  phases = process.env[PROFILE_ENVIRONMENT_NAME] === "1" ? [] : undefined;
}

/** Measures a trusted analysis phase when profiling is explicitly enabled. */
export function profileInspectionPhase<Value>(name: string, inspect: () => Value): Value {
  if (phases === undefined) {
    return inspect();
  }
  const startedAt = performance.now();
  try {
    return inspect();
  } finally {
    phases.push({ name, milliseconds: roundedMilliseconds(performance.now() - startedAt) });
  }
}

/** Returns and clears the current profile so a later request cannot inherit it. */
export function completeInspectionProfile(): InspectionProfile | undefined {
  const completedPhases = phases;
  phases = undefined;
  return completedPhases === undefined
    ? undefined
    : {
        kind: "inspection-profile",
        schemaVersion: PROFILE_SCHEMA_VERSION,
        phases: completedPhases,
      };
}

export function inspectionProfilingRequested(): boolean {
  return process.env[PROFILE_ENVIRONMENT_NAME] === "1";
}

function roundedMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds * 1_000) / 1_000;
}
