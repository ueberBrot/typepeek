import { readFileSync } from "node:fs";

import { Result, Schema } from "effect";

import { decodeJson } from "#typepeek/shared/json-data";

const embeddedTypepeekVersion = globalThis.__TYPEPEEK_VERSION__;

const decodePackageVersion = Schema.decodeUnknownResult(
  Schema.Struct({ version: Schema.String })
);

const readSourcePackageVersion = function readSourcePackageVersion(): string {
  const manifest = Result.getOrUndefined(
    decodePackageVersion(
      decodeJson(
        Schema.Unknown,
        readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
      )
    )
  );

  if (manifest === undefined) {
    throw new Error("Typepeek package manifest has no version.");
  }

  return manifest.version;
};

/** The package version embedded into cache semantics by both source and packaged builds. */
export const TYPEPEEK_VERSION =
  embeddedTypepeekVersion ?? readSourcePackageVersion();

export const HAS_EMBEDDED_TYPEPEEK_VERSION =
  embeddedTypepeekVersion !== undefined;
