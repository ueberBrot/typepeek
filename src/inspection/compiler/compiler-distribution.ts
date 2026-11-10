import { layer } from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, Option } from "effect";
import { typescriptVersion, version } from "tsrs";

import { createRequire } from "#typepeek/platform/node-module";
import { platformPath as path } from "#typepeek/platform/platform-path";

export const COMPILER_VERSION = `${typescriptVersion}/tsrs-${version}`;

const platformDirectory = Effect.gen(function* platformDirectory() {
  const fs = yield* FileSystem.FileSystem;
  let anchor: string | URL = import.meta.url;

  if (globalThis.__TYPEPEEK_COMPILED__ === true) {
    anchor = yield* path.toFileUrl(yield* fs.realPath(process.execPath));
  }

  const require = createRequire(
    createRequire(anchor).resolve("tsrs/package.json")
  );

  const base = `@tsrs/${process.platform}-${process.arch}`;

  const candidates =
    process.platform === "linux" ? [`${base}-gnu`, `${base}-musl`] : [base];

  const executable = process.platform === "win32" ? "tsrs.exe" : "tsrs";

  for (const candidate of candidates) {
    const manifest = yield* Effect.try(() =>
      require.resolve(`${candidate}/package.json`)
    ).pipe(Effect.option);

    if (Option.isNone(manifest)) {
      continue;
    }

    const directory = path.dirname(manifest.value);

    if (yield* fs.exists(path.join(directory, executable))) {
      return directory;
    }
  }

  return yield* Effect.die(
    new Error(
      `The pinned TSRS native dependency is missing for ${process.platform}-${process.arch}.`
    )
  );
});

export const COMPILER_LIBRARY_DIRECTORY = await Effect.runPromise(
  platformDirectory.pipe(Effect.provide(layer))
);

export const COMPILER_EXECUTABLE = path.join(
  COMPILER_LIBRARY_DIRECTORY,
  process.platform === "win32" ? "tsrs.exe" : "tsrs"
);

export const COMPILER_INTRINSIC_FILE = path.join(
  COMPILER_LIBRARY_DIRECTORY,
  "__typepeek_intrinsics__.d.ts"
);

export const COMPILER_INTRINSIC_SOURCE = "export type EmptyArguments = [];";
