import { Result, Schema } from "effect";

const PROFILE_SCHEMA_VERSION = 1;
const nonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const inspectionProfilePhaseSchema = Schema.Struct({
  name: Schema.String,
  milliseconds: nonNegativeFiniteSchema,
});
const inspectionProfileSchema = Schema.Struct({
  kind: Schema.Literal("inspection-profile"),
  schemaVersion: Schema.Literal(PROFILE_SCHEMA_VERSION),
  maxRssBytes: Schema.Finite.check(Schema.isGreaterThan(0)),
  phases: Schema.Array(inspectionProfilePhaseSchema),
});
const decodeProfile = Schema.decodeUnknownResult(inspectionProfileSchema);

/** Build and pack replace this expression with `false`; source diagnostics retain it. */
export const inspectionProfilingEnabled = process.env["TYPEPEEK_PROFILE"] === "1";

type InspectionProfilePhase = typeof inspectionProfilePhaseSchema.Type;
export type InspectionProfile = typeof inspectionProfileSchema.Type;

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
        maxRssBytes: process.resourceUsage().maxRSS * 1_024,
        phases: completedPhases,
      };
}

/** Validates and forwards one bounded source-diagnostic profile. */
export function forwardInspectionProfile(serialized: Uint8Array): void {
  const profile = decodeInspectionProfile(serialized);
  if (profile !== undefined) {
    process.stderr.write(`${JSON.stringify(profile)}\n`);
  }
}

/** Decodes one bounded analysis-process profile at a diagnostic transport seam. */
export function decodeInspectionProfile(
  serialized: string | Uint8Array,
): InspectionProfile | undefined {
  try {
    const text =
      typeof serialized === "string"
        ? serialized
        : new TextDecoder("utf-8", { fatal: true }).decode(serialized);
    return Result.getOrUndefined(decodeProfile(JSON.parse(text) as unknown));
  } catch {
    return undefined;
  }
}

function roundedMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds * 1_000) / 1_000;
}
