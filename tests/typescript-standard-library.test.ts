import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createStandardLibraryPredicate } from "#typepeek/inspection/typescript-standard-library";

const isStandardLibrary = createStandardLibraryPredicate(
  "C:\\Users\\RUNNER~1\\typepeek\\node_modules\\typescript\\lib",
  "C:\\Users\\runneradmin\\typepeek\\node_modules\\typescript\\lib",
  path.win32
);

describe("TypeScript standard library identity on Windows", () => {
  it.each([
    "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/lib.es5.d.ts",
    "c:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/lib.es5.d.ts",
    "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/lib.es5.d.ts",
  ])("recognizes the analyzer library declaration %s", (fileName) => {
    expect(isStandardLibrary(fileName)).toBeTruthy();
  });

  it.each([
    "C:/consumer/node_modules/typescript/lib/lib.es5.d.ts",
    "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/nested/lib.es5.d.ts",
    "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/../lib.es5.d.ts",
    "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/nested/lib.es5.d.ts",
    "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/../lib.es5.d.ts",
    "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/index.d.ts",
  ])("rejects declarations outside the analyzer library: %s", (fileName) => {
    expect(isStandardLibrary(fileName)).toBeFalsy();
  });
});
