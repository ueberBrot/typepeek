import type TypeScript from "@typescript/typescript6";
import { createRequire } from "node:module";

/** Build alias: load the shipped compiler without scanning its CommonJS exports. */
const ts = createRequire(import.meta.url)("@typescript/typescript6") as typeof TypeScript;

export default ts;
