import { Predicate, Result, Schema } from "effect";

import { decodeJson } from "#typepeek/shared/json-data";

const PROFILE_SCHEMA_VERSION = 1;

const nonNegativeFiniteSchema = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0)
);

const inspectionProfilePhaseSchema = Schema.Struct({
  milliseconds: nonNegativeFiniteSchema,
  name: Schema.String,
});

const inspectionProfileSchema = Schema.Struct({
  kind: Schema.Literal("inspection-profile"),
  maxRssBytes: Schema.Finite.check(Schema.isGreaterThan(0)),
  phases: Schema.Array(inspectionProfilePhaseSchema),
  schemaVersion: Schema.Literal(PROFILE_SCHEMA_VERSION),
});

const decodeProfile = Schema.decodeUnknownResult(inspectionProfileSchema);

/** Packaged builds use performance-profile-disabled.ts instead of this module. */
export const inspectionProfilingEnabled =
  process.env["TYPEPEEK_PROFILE"] === "1";

type InspectionProfilePhase = typeof inspectionProfilePhaseSchema.Type;

export type InspectionProfile = typeof inspectionProfileSchema.Type;

let phases: InspectionProfilePhase[] | null = null;

/** Starts a process-local profile, kept separate from Inspection Results. */
export const beginInspectionProfile = function beginInspectionProfile(): void {
  phases = inspectionProfilingEnabled ? [] : null;
};

const roundedMilliseconds = function roundedMilliseconds(
  milliseconds: number
): number {
  return Math.round(milliseconds * 1000) / 1000;
};

export const profileInspectionPhase = function profileInspectionPhase<Value>(
  name: string,
  inspect: () => Value
): Value {
  if (phases === null) {
    return inspect();
  }

  const startedAt = performance.now();

  try {
    return inspect();
  } finally {
    phases.push({
      milliseconds: roundedMilliseconds(performance.now() - startedAt),
      name,
    });
  }
};

/** Returns and clears the current profile so a later request cannot inherit it. */
export const completeInspectionProfile = function completeInspectionProfile():
  | InspectionProfile
  | undefined {
  const completedPhases = phases;
  phases = null;

  return completedPhases === null
    ? undefined
    : {
        kind: "inspection-profile",
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
        phases: completedPhases,
        schemaVersion: PROFILE_SCHEMA_VERSION,
      };
};

const decodeInspectionProfile = function decodeInspectionProfile(
  serialized: string | Uint8Array
): InspectionProfile | undefined {
  try {
    const text = Predicate.isString(serialized)
      ? serialized
      : new TextDecoder("utf-8", { fatal: true }).decode(serialized);

    return Result.getOrUndefined(
      decodeProfile(decodeJson(Schema.Unknown, text))
    );
  } catch {
    return undefined;
  }
};

export const forwardInspectionProfile = function forwardInspectionProfile(
  serialized: Uint8Array
): void {
  const profile = decodeInspectionProfile(serialized);

  if (profile !== undefined) {
    process.stderr.write(`${JSON.stringify(profile)}\n`);
  }
};
