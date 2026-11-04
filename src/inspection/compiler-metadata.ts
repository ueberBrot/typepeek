import { createRequire } from "node:module";

import { Schema } from "effect";

/** Packaged parents validate cache versions without initializing the compiler runtime. */
export const COMPILER_VERSION =
  globalThis.__TYPEPEEK_COMPILER_VERSION__ ??
  Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    createRequire(import.meta.url)("@typescript/typescript6")
  ).version;
