import { runMain } from "@effect/platform-bun/BunRuntime";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { forEach as forEachEffect } from "effect/Effect";

import { hostNativePackage } from "#typepeek/distribution/native-platform";
import { COMPILER_LIBRARY_DIRECTORY } from "#typepeek/inspection/compiler/compiler-distribution";
import { COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-metadata";
import { readStandardGlobalCatalogEffect } from "#typepeek/inspection/compiler/standard-global-catalog";
import { createRequire } from "#typepeek/platform/node-module";
import { runCommandEffect } from "#typepeek/platform/process-command";
import { cliLayer } from "#typepeek/platform/process-runtime";
import { writeStdout, writeStderr } from "#typepeek/platform/stdio";
import { decodeJson } from "#typepeek/shared/json-data";

const PACKAGE_MANIFEST_FILE = "package.json";

const releaseProfilePlugin = (file: string): Bun.BunPlugin => ({
  name: "release-profiling",
  setup(build) {
    build.onResolve(
      { filter: /^#typepeek\/inspection\/execution\/performance-profile$/u },
      () => ({ path: file })
    );
  },
});

const taggedError = Schema.TaggedError;

class AotBuildError extends taggedError<
  AotBuildError,
  { readonly brand: unique symbol }
>()("AotBuildError", {
  message: Schema.String,
}) {}

const buildPackage = Effect.fnUntraced(function* buildPackage(values: {
  readonly compiler: Option.Option<string>;
  readonly mode: "aot" | "jit";
  readonly output: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const output = path.resolve(values.output);

  let { compiler } = values;

  if (Option.isNone(compiler) && !Bun.revision.startsWith("271b65ec6")) {
    const packageName = yield* hostNativePackage;

    if (packageName === undefined) {
      return yield* new AotBuildError({
        message: "No AOT compiler is available for this host.",
      });
    }

    const ovenTarget = packageName
      .slice("typepeek-".length)
      .replace("win32", "windows")
      .replace("arm64", "aarch64")
      .replace("-gnu", "");

    const compilerManifest = createRequire(
      new URL("../tooling/aot-compiler/package.json", import.meta.url)
    ).resolve(`@oven/bun-${ovenTarget}/package.json`);

    compiler = Option.some(
      path.join(
        path.dirname(compilerManifest),
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun"
      )
    );
  }

  if (Option.isSome(compiler)) {
    const entry = yield* path.fromFileUrl(new URL(import.meta.url));

    const result = yield* runCommandEffect(compiler.value, [
      entry,
      "--mode",
      values.mode,
      "--output",
      output,
    ]);

    yield* writeStdout(result.stdout);
    yield* writeStderr(result.stderr);

    return yield* Effect.void;
  }

  const help = yield* runCommandEffect(process.execPath, ["build", "--help"]);

  if (values.mode === "aot" && !/--aot\s/u.test(help.stdout)) {
    return yield* new AotBuildError({
      message: "The running Bun compiler does not support AOT compilation.",
    });
  }

  const binaryDirectory = path.join(output, "dist");

  const manifestText = yield* fs.readFileString(PACKAGE_MANIFEST_FILE);

  const manifest = decodeJson(
    Schema.Struct({ version: Schema.String }),
    manifestText
  );

  const standardGlobals = yield* readStandardGlobalCatalogEffect();

  const nativePackage = decodeJson(
    Schema.Struct({ name: Schema.String }),
    yield* fs.readFileString(
      path.join(COMPILER_LIBRARY_DIRECTORY, PACKAGE_MANIFEST_FILE)
    )
  );

  const define = {
    "globalThis.__TYPEPEEK_COMPILED__": "true",
    "globalThis.__TYPEPEEK_COMPILER_PLATFORM__": JSON.stringify(
      nativePackage.name
    ),
    "globalThis.__TYPEPEEK_COMPILER_VERSION__":
      JSON.stringify(COMPILER_VERSION),
    "globalThis.__TYPEPEEK_STANDARD_GLOBALS__": JSON.stringify(standardGlobals),
    "globalThis.__TYPEPEEK_VERSION__": JSON.stringify(manifest.version),
  };

  yield* fs.makeDirectory(binaryDirectory, { recursive: true });

  const entries = [
    ["src/cli.ts", "typepeek"],
    ["src/inspection/analysis-process-entry.ts", "typepeek-analysis"],
  ] as const;

  const profilePlugin = releaseProfilePlugin(
    path.resolve("src/inspection/execution/performance-profile-disabled.ts")
  );

  yield* forEachEffect(
    entries,
    ([entry, name]) =>
      Effect.gen(function* compileEntry() {
        const compile: Bun.CompileBuildOptions & { readonly aot: boolean } = {
          aot: values.mode === "aot",
          autoloadBunfig: false,
          autoloadDotenv: false,
          autoloadPackageJson: false,
          autoloadTsconfig: false,
          outfile: path.join(
            binaryDirectory,
            process.platform === "win32" ? `${name}.exe` : name
          ),
        };

        const result = yield* Effect.tryPromise({
          catch: (cause) =>
            new AotBuildError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          try: async () =>
            await Bun.build({
              compile,
              define,
              entrypoints: [path.resolve(entry)],
              plugins: [profilePlugin],
            }),
        });

        if (!result.success) {
          return yield* new AotBuildError({
            message: result.logs.map((log) => log.message).join("\n"),
          });
        }

        yield* forEachEffect(
          result.logs,
          (log) => writeStderr(`${log.message}\n`),
          { discard: true }
        );

        return yield* Effect.void;
      }),
    { discard: true }
  );

  const packageName = yield* hostNativePackage;

  if (packageName === undefined) {
    return yield* new AotBuildError({
      message: "This host has no supported TSRS native distribution.",
    });
  }

  const platformManifest = yield* fs.readFileString(
    path.join("packages", packageName, PACKAGE_MANIFEST_FILE)
  );

  yield* fs.writeFileString(
    path.join(output, PACKAGE_MANIFEST_FILE),
    platformManifest
  );
  yield* fs.copyFile("LICENSE", path.join(output, "LICENSE"));

  return yield* Effect.void;
});

const command = Command.make(
  "build-aot",
  {
    compiler: Flag.String("compiler").pipe(Flag.optional),
    mode: Flag.Literals("mode", ["aot", "jit"]).pipe(Flag.withDefault("aot")),
    output: Flag.String("output").pipe(
      Flag.withDefault(".vite-plus/aot-package")
    ),
  },
  buildPackage
);

runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(cliLayer))
);
