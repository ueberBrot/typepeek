import ts from "@typescript/typescript6";
import { realpathSync } from "node:fs";
import { basename, dirname, relative } from "node:path";

export const INSPECTION_STANDARD_LIBRARY = "lib.es2024.d.ts";

const STANDARD_LIBRARY_ROOT = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2024 }));
const CANONICAL_STANDARD_LIBRARY_ROOT = realpathSync.native(STANDARD_LIBRARY_ROOT);
const STANDARD_LIBRARY_DECLARATION = /^lib\..+\.d\.ts$/u;

/** Identifies declarations shipped with Typepeek's pinned TypeScript analyzer. */
export function isTypeScriptStandardLibraryDeclaration(fileName: string): boolean {
  return (
    (relative(STANDARD_LIBRARY_ROOT, dirname(fileName)) === "" ||
      relative(CANONICAL_STANDARD_LIBRARY_ROOT, dirname(fileName)) === "") &&
    STANDARD_LIBRARY_DECLARATION.test(basename(fileName))
  );
}
