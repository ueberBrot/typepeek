import { createFileSystem } from "tsrs/fs";
import { API } from "tsrs/sync";
import type { Program, RawCompilerOptions } from "tsrs/sync";

import { COMPILER_EXECUTABLE } from "#typepeek/inspection/compiler-distribution";
import { retainCompilerProgram } from "#typepeek/inspection/compiler-session";

/** Fixture compiler uses the SDK directly, independently of the evidence loader. */
export const createFixtureProgram = (
  roots: readonly string[],
  options: RawCompilerOptions,
  files?: readonly (readonly [string, string])[]
): Program => {
  const api = new API({
    runExternalCode: false,
    tsserverPath: COMPILER_EXECUTABLE,
  });

  if (files === undefined) {
    return retainCompilerProgram(api.createProgram(roots, options), api);
  }

  const snapshot = api.createSnapshot({
    createPrograms: [{ compilerOptions: options, rootFiles: roots }],
    fileSystem: createFileSystem(files),
  });

  const program = snapshot.operation?.createdPrograms?.[0];

  if (program === undefined) {
    throw new Error("The fixture compiler did not create its program.");
  }

  return retainCompilerProgram(program, api);
};
