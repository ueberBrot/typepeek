import { runMain } from "@effect/platform-bun/BunRuntime";
import { Effect, FileSystem, Path, Schema } from "effect";

import { processLayer } from "#typepeek/platform/process-runtime";
import { decodeJson } from "#typepeek/shared/json-data";

const manifestSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

runMain(
  Effect.gen(function* verifyNativePackages() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const root = decodeJson(
      Schema.Struct({
        optionalDependencies: Schema.Record(Schema.String, Schema.String),
        version: Schema.String,
      }),
      yield* fs.readFileString("package.json")
    );

    for (const name of Object.keys(root.optionalDependencies)) {
      const directory = path.join("packages", name);

      const manifest = decodeJson(
        manifestSchema,
        yield* fs.readFileString(path.join(directory, "package.json"))
      );

      if (manifest.name !== name || manifest.version !== root.version) {
        return yield* Effect.die(
          new Error(`Native package version mismatch: ${name}`)
        );
      }

      for (const binary of ["typepeek", "typepeek-analysis"]) {
        const file = path.join(
          directory,
          "dist",
          name.includes("win32") ? `${binary}.exe` : binary
        );

        const stat = yield* fs.stat(file);

        if (stat.size === 0n) {
          return yield* Effect.die(new Error(`Empty native binary: ${file}`));
        }

        // oxlint-disable-next-line sonarjs/file-permissions -- Artifact downloads strip executable bits; these files are public CLI executables.
        yield* fs.chmod(file, 0o755);
      }

      yield* fs.copyFile("LICENSE", path.join(directory, "LICENSE"));
    }

    return yield* Effect.void;
  }).pipe(Effect.provide(processLayer))
);
