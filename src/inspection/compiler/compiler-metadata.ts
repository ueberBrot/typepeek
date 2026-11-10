import { COMPILER_VERSION as SDK_COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-distribution";

export { typescriptVersion as COMPILER_TYPESCRIPT_VERSION } from "tsrs";

export const COMPILER_VERSION =
  globalThis.__TYPEPEEK_COMPILER_VERSION__ ?? SDK_COMPILER_VERSION;
