import { Result, Schema } from "effect";
import { readFileSync } from "node:fs";

declare const __TYPEPEEK_VERSION__: string | undefined;

const embeddedTypepeekVersion =
  typeof __TYPEPEEK_VERSION__ === "string" ? __TYPEPEEK_VERSION__ : undefined;
const decodePackageVersion = Schema.decodeUnknownResult(Schema.Struct({ version: Schema.String }));

/** The package version embedded into cache semantics by both source and packaged builds. */
export const TYPEPEEK_VERSION = embeddedTypepeekVersion ?? readSourcePackageVersion();

/** True only when the build injected a stable package identity. */
export const HAS_EMBEDDED_TYPEPEEK_VERSION = embeddedTypepeekVersion !== undefined;

function readSourcePackageVersion(): string {
  const manifest = Result.getOrUndefined(
    decodePackageVersion(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown,
    ),
  );
  if (manifest === undefined) {
    throw new Error("Typepeek package manifest has no version.");
  }
  return manifest.version;
}
