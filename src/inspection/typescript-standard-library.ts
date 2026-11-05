import { realpathSync } from "node:fs";
import path from "node:path";

import { COMPILER_LIBRARY_DIRECTORY } from "#typepeek/inspection/compiler-distribution";

export const INSPECTION_STANDARD_LIBRARY = "lib.es2024.d.ts";
const STANDARD_LIBRARY_DECLARATION = /^lib\..+\.d\.ts$/u;

export type LibraryPathOperations = Pick<
  typeof path,
  "basename" | "dirname" | "relative"
>;

/** Binds library identity to the analyzer's logical and canonical directories. */
export const createStandardLibraryPredicate =
  (
    root: string,
    canonicalRoot: string,
    paths: LibraryPathOperations
  ): ((fileName: string) => boolean) =>
  (fileName) =>
    (paths.relative(root, paths.dirname(fileName)) === "" ||
      paths.relative(canonicalRoot, paths.dirname(fileName)) === "") &&
    STANDARD_LIBRARY_DECLARATION.test(paths.basename(fileName));

const standardLibraryRoot = COMPILER_LIBRARY_DIRECTORY;

/** Identifies declarations shipped with Typepeek's pinned TypeScript analyzer. */
export const isTypeScriptStandardLibraryDeclaration =
  createStandardLibraryPredicate(
    standardLibraryRoot,
    realpathSync.native(standardLibraryRoot),
    path
  );
