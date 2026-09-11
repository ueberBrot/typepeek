import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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

export function readJsonPackageIdentity(value: unknown): PackageIdentity | undefined {
  const snapshot = snapshotDataProperties(value, PACKAGE_IDENTITY_FIELDS);
  if (snapshot === undefined) {
    return undefined;
  }
  // Decode fields separately: whole-Struct decoding creates an object that a polluted
  // Object.prototype can disrupt.
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
