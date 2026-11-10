import { layer } from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, Predicate, Schema } from "effect";

import { createRequire } from "#typepeek/platform/node-module";
import { platformPath as path } from "#typepeek/platform/platform-path";

const sdkPlatformSchema = Schema.Struct({
  getPlatformPackageName: Schema.declare((input): input is () => string =>
    Predicate.isFunction(input)
  ),
});

export const resolveCompilerLibraryDirectory = Effect.fnUntraced(
  function* resolveCompilerLibraryDirectory(anchor: string | URL) {
    const fs = yield* FileSystem.FileSystem;
    const sdkManifest = createRequire(anchor).resolve("tsrs/package.json");
    const require = createRequire(sdkManifest);

    const candidate =
      globalThis.__TYPEPEEK_COMPILER_PLATFORM__ ??
      (yield* Effect.gen(function* sdkPlatformPackage() {
        const platformFile = path.join(
          path.dirname(sdkManifest),
          "lib",
          "platform.js"
        );

        const sdkPlatform = yield* Effect.try(() => {
          const loaded: unknown = require(platformFile);

          return loaded;
        });

        const { getPlatformPackageName } =
          yield* Schema.decodeUnknownEffect(sdkPlatformSchema)(sdkPlatform);

        return yield* Schema.decodeEffect(Schema.String)(
          getPlatformPackageName()
        );
      }));

    const manifest = yield* Effect.try(() =>
      require.resolve(`${candidate}/package.json`)
    );

    const directory = path.dirname(manifest);
    const executable = process.platform === "win32" ? "tsrs.exe" : "tsrs";

    if (yield* fs.exists(path.join(directory, executable))) {
      return directory;
    }

    return yield* Effect.die(
      new Error(
        `The pinned TSRS native dependency is missing for ${candidate}.`
      )
    );
  }
);

export const COMPILER_LIBRARY_DIRECTORY = await Effect.runPromise(
  Effect.gen(function* compilerLibraryDirectory() {
    const fs = yield* FileSystem.FileSystem;

    const anchor =
      globalThis.__TYPEPEEK_COMPILED__ === true
        ? yield* path.toFileUrl(yield* fs.realPath(process.execPath))
        : import.meta.url;

    return yield* resolveCompilerLibraryDirectory(anchor);
  }).pipe(Effect.provide(layer))
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
