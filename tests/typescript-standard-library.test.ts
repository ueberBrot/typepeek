import { expect, it, vi } from "vite-plus/test";

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path.win32 };
});
vi.mock("@typescript/typescript6", async (importOriginal) => {
  const { default: compiler } = await importOriginal<{
    default: typeof import("@typescript/typescript6");
  }>();
  return {
    default: {
      ...compiler,
      getDefaultLibFilePath: () =>
        "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/lib.es2024.d.ts",
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const realpath = () => "C:\\Users\\RUNNER~1\\typepeek\\node_modules\\typescript\\lib";
  const native = () => "C:\\Users\\runneradmin\\typepeek\\node_modules\\typescript\\lib";
  return { ...fs, realpathSync: Object.assign(realpath, { native }) };
});

import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/typescript-standard-library";

it("recognizes TypeScript's short-name and forward-slash library paths on Windows", () => {
  expect(
    isTypeScriptStandardLibraryDeclaration(
      "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/lib.es5.d.ts",
    ),
  ).toBe(true);
});

it("recognizes equivalent Windows drive casing", () => {
  expect(
    isTypeScriptStandardLibraryDeclaration(
      "c:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/lib.es5.d.ts",
    ),
  ).toBe(true);
});

it("rejects declarations outside the analyzer library directory", () => {
  for (const path of [
    "C:/consumer/node_modules/typescript/lib/lib.es5.d.ts",
    "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/nested/lib.es5.d.ts",
    "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/../lib.es5.d.ts",
    "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/nested/lib.es5.d.ts",
    "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/../lib.es5.d.ts",
    "C:/Users/RUNNER~1/typepeek/node_modules/typescript/lib/index.d.ts",
  ]) {
    expect(isTypeScriptStandardLibraryDeclaration(path)).toBe(false);
  }
});

it("recognizes the native long-name spelling of the same Windows library directory", () => {
  expect(
    isTypeScriptStandardLibraryDeclaration(
      "C:/Users/runneradmin/typepeek/node_modules/typescript/lib/lib.es5.d.ts",
    ),
  ).toBe(true);
});
