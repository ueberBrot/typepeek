import { COMPILER_VERSION as SDK_COMPILER_VERSION } from "#typepeek/inspection/compiler-distribution";

/** Cache identity includes both the native implementation and upstream language versions. */
export const COMPILER_VERSION =
  globalThis.__TYPEPEEK_COMPILER_VERSION__ ?? SDK_COMPILER_VERSION;
