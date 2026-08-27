import { Result, Schema } from "effect";

import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const PACKAGE_IDENTITY_FIELDS = ["name", "version"] as const;
const packageIdentityNameSchema = Schema.String;
const packageIdentityVersionSchema = Schema.String;

export const packageIdentitySchema = Schema.Struct({
  name: packageIdentityNameSchema,
  version: Schema.optionalKey(packageIdentityVersionSchema),
});

export type PackageIdentity = typeof packageIdentitySchema.Type;

const decodePackageIdentityName = Schema.decodeUnknownResult(packageIdentityNameSchema);
const decodePackageIdentityVersion = Schema.decodeUnknownResult(packageIdentityVersionSchema);

/** Reads canonical Package Identity fields from parsed JSON manifest evidence. */
export function readJsonPackageIdentity(value: unknown): PackageIdentity | undefined {
  const snapshot = snapshotDataProperties(value, PACKAGE_IDENTITY_FIELDS);
  if (snapshot === undefined) {
    return undefined;
  }
  // Decode the safe own-data snapshot field by field: whole-Struct decoding creates a normal
  // object that a polluted Object.prototype can disrupt. The Struct still owns the public type.
  const name = Result.getOrUndefined(decodePackageIdentityName(snapshot["name"]));
  if (name === undefined) {
    return undefined;
  }
  if (!Object.hasOwn(snapshot, "version")) {
    return { name };
  }
  const version = Result.getOrUndefined(decodePackageIdentityVersion(snapshot["version"]));
  return version === undefined ? undefined : { name, version };
}
