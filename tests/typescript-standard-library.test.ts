import { expect, it, vi } from "vite-plus/test";

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path.win32 };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const realpath = () => "C:\\typepeek\\node_modules\\typescript\\lib";
  return { ...fs, realpathSync: Object.assign(realpath, { native: realpath }) };
});

import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/typescript-standard-library";

it("recognizes TypeScript's forward-slash library paths on Windows", () => {
  expect(
    isTypeScriptStandardLibraryDeclaration("C:/typepeek/node_modules/typescript/lib/lib.es5.d.ts"),
  ).toBe(true);
});

it("recognizes equivalent Windows drive casing", () => {
  expect(
    isTypeScriptStandardLibraryDeclaration("c:/typepeek/node_modules/typescript/lib/lib.es5.d.ts"),
  ).toBe(true);
});

it("rejects declarations outside the analyzer library directory", () => {
  for (const path of [
    "C:/consumer/node_modules/typescript/lib/lib.es5.d.ts",
    "C:/typepeek/node_modules/typescript/lib/nested/lib.es5.d.ts",
    "C:/typepeek/node_modules/typescript/lib/../lib.es5.d.ts",
    "C:/typepeek/node_modules/typescript/lib/index.d.ts",
  ]) {
    expect(isTypeScriptStandardLibraryDeclaration(path)).toBe(false);
  }
});
