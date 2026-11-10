import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess } from "effect/process";

import { hostNativePackage } from "#typepeek/distribution/native-platform";
import { createRequire } from "#typepeek/platform/node-module";
import { spawnProcess } from "#typepeek/platform/process-runtime";
import { setExitCode } from "#typepeek/platform/runtime-process";
import { decodeJson } from "#typepeek/shared/json-data";

const taggedError = Schema.TaggedError;

class NativeLauncherError extends taggedError<
  NativeLauncherError,
  { readonly brand: unique symbol }
>()("NativeLauncherError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

const moduleResolutionError = Schema.Struct({ code: Schema.String });

export const resolveNativeManifest = (anchor: string | URL, name: string) =>
  Effect.try({
    catch: (cause) =>
      new NativeLauncherError({ cause, message: `Could not resolve ${name}.` }),
    try: () => {
      try {
        return Option.some(
          createRequire(anchor).resolve(`${name}/package.json`)
        );
      } catch (error) {
        if (
          Schema.is(moduleResolutionError)(error) &&
          error.code === "MODULE_NOT_FOUND"
        ) {
          return Option.none<string>();
        }

        throw error;
      }
    },
  });

export const launchNative = Effect.fnUntraced(function* launchNative(
  anchor: string | URL,
  cliArguments: readonly string[]
) {
  const name = yield* hostNativePackage;

  if (name === undefined) {
    return false;
  }

  const manifestPath = yield* resolveNativeManifest(anchor, name);

  if (Option.isNone(manifestPath)) {
    return false;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const manifest = decodeJson(
    Schema.Struct({ name: Schema.String, version: Schema.String }),
    yield* fs.readFileString(manifestPath.value)
  );

  if (
    manifest.name !== name ||
    manifest.version !== globalThis.__TYPEPEEK_VERSION__
  ) {
    return yield* new NativeLauncherError({
      message: `Reinstall typepeek: ${name} has an incompatible version.`,
    });
  }

  const binary = path.join(
    path.dirname(manifestPath.value),
    "dist",
    process.platform === "win32" ? "typepeek.exe" : "typepeek"
  );

  const child = yield* spawnProcess(
    ChildProcess.make(binary, cliArguments, {
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    })
  );

  yield* setExitCode(yield* child.exitCode);

  return true;
});
