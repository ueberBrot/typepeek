const PROFILE_SCHEMA_VERSION = 1;

/** Build and pack replace this expression with `false`; source diagnostics retain it. */
export const inspectionProfilingEnabled = process.env["TYPEPEEK_PROFILE"] === "1";

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
  phases = inspectionProfilingEnabled ? [] : undefined;
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

/** Validates and forwards one bounded source-diagnostic profile. */
export function forwardInspectionProfile(serialized: Uint8Array): void {
  const profile = parseInspectionProfile(serialized);
  if (profile !== undefined) {
    process.stderr.write(`${JSON.stringify(profile)}\n`);
  }
}

function parseInspectionProfile(serialized: Uint8Array): InspectionProfile | undefined {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(serialized),
    ) as unknown;
    if (
      !isRecord(value) ||
      value["kind"] !== "inspection-profile" ||
      value["schemaVersion"] !== 1
    ) {
      return undefined;
    }
    const candidatePhases = value["phases"];
    if (
      !Array.isArray(candidatePhases) ||
      !candidatePhases.every(
        (phase) =>
          isRecord(phase) &&
          typeof phase["name"] === "string" &&
          typeof phase["milliseconds"] === "number" &&
          Number.isFinite(phase["milliseconds"]) &&
          phase["milliseconds"] >= 0,
      )
    ) {
      return undefined;
    }
    return value as unknown as InspectionProfile;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundedMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds * 1_000) / 1_000;
}
