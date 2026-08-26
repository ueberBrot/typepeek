import { Result, Schema } from "effect";

import { snapshotDataProperties } from "#typepeek/inspection/untrusted-data";

const PACKAGE_IDENTITY_FIELDS = ["name", "version"] as const;
const packageIdentityNameSchema = Schema.String;
const packageIdentityVersionSchema = Schema.String;

export const packageIdentitySchema = Schema.Struct({
  name: packageIdentityNameSchema,
  version: Schema.optional(packageIdentityVersionSchema),
});

export type PackageIdentity = {
  readonly name: (typeof packageIdentitySchema.Type)["name"];
  readonly version?: Exclude<(typeof packageIdentitySchema.Type)["version"], undefined>;
};

const decodePackageIdentityName = Schema.decodeUnknownResult(packageIdentityNameSchema);
const decodePackageIdentityVersion = Schema.decodeUnknownResult(packageIdentityVersionSchema);

/** Reads canonical Package Identity fields from parsed JSON manifest evidence. */
export function readJsonPackageIdentity(value: unknown): PackageIdentity | undefined {
  const snapshot = snapshotDataProperties(value, PACKAGE_IDENTITY_FIELDS);
  if (snapshot === undefined) {
    return undefined;
  }
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
