import { API } from "tsrs/async";
import type { Program, RawCompilerOptions } from "tsrs/async";
import { createFileSystem } from "tsrs/fs";

import { COMPILER_EXECUTABLE } from "#typepeek/inspection/compiler/compiler-distribution";
import { retainCompilerProgram } from "#typepeek/inspection/compiler/compiler-session";

/** Fixture compiler uses the SDK directly, independently of the evidence loader. */
export const createFixtureProgram = async (
  roots: readonly string[],
  options: RawCompilerOptions,
  files?: readonly (readonly [string, string])[]
): Promise<Program> => {
  const api = new API({
    runExternalCode: false,
    tsserverPath: COMPILER_EXECUTABLE,
  });

  if (files === undefined) {
    return retainCompilerProgram(await api.createProgram(roots, options), api);
  }

  const snapshot = await api.createSnapshot({
    createPrograms: [{ compilerOptions: options, rootFiles: roots }],
    fileSystem: createFileSystem(files),
  });

  const program = snapshot.operation?.createdPrograms?.[0];

  if (program === undefined) {
    throw new Error("The fixture compiler did not create its program.");
  }

  return retainCompilerProgram(program, api);
};
