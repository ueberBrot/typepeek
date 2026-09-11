import { createRequire } from "node:module";

declare const __TYPEPEEK_COMPILER_VERSION__: string | undefined;

/** Packaged parents validate cache versions without initializing the compiler runtime. */
export const COMPILER_VERSION =
  typeof __TYPEPEEK_COMPILER_VERSION__ === "string"
    ? __TYPEPEEK_COMPILER_VERSION__
    : (createRequire(import.meta.url)("@typescript/typescript6") as { readonly version: string })
        .version;
