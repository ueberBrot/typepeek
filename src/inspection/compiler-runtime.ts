import { createRequire } from "node:module";

import type TypeScript from "@typescript/typescript6";

/** Build alias: load the shipped compiler without scanning its CommonJS exports. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The fixed package specifier loads the pinned compiler whose declarations are imported above; this bridge preserves its CommonJS export object.
const ts = createRequire(import.meta.url)(
  "@typescript/typescript6"
) as typeof TypeScript;

export default ts;
