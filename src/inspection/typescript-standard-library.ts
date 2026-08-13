import ts from "@typescript/typescript6";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

export const INSPECTION_STANDARD_LIBRARY = "lib.es2024.d.ts";

const STANDARD_LIBRARY_ROOT = realpathSync(
  dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2024 })),
);
const STANDARD_LIBRARY_DECLARATION = /^lib\..+\.d\.ts$/u;

/** Identifies declarations shipped with Typepeek's pinned TypeScript analyzer. */
export function isTypeScriptStandardLibraryDeclaration(fileName: string): boolean {
  return (
    dirname(fileName) === STANDARD_LIBRARY_ROOT &&
    STANDARD_LIBRARY_DECLARATION.test(basename(fileName))
  );
}
