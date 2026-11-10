import { typescriptVersion, version } from "tsrs";

export { typescriptVersion as COMPILER_TYPESCRIPT_VERSION } from "tsrs";

/** Cache identity includes both the native implementation and upstream language versions. */
export const COMPILER_VERSION =
  globalThis.__TYPEPEEK_COMPILER_VERSION__ ??
  `${typescriptVersion}/tsrs-${version}`;
