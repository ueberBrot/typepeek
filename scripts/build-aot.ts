import { runMain } from "@effect/platform-bun/BunRuntime";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { forEach as forEachEffect } from "effect/Effect";

import { COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-metadata";
import { readStandardGlobalCatalogEffect } from "#typepeek/inspection/compiler/standard-global-catalog";
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

  if (Option.isSome(values.compiler)) {
    const entry = yield* path.fromFileUrl(new URL(import.meta.url));

    const result = yield* runCommandEffect(values.compiler.value, [
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

  const define = {
    "globalThis.__TYPEPEEK_COMPILED__": "true",
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

  const omittedFields = new Set([
    "devDependencies",
    "engines",
    "imports",
    "packageManager",
    "scripts",
  ]);

  const metadata = Object.fromEntries(
    Object.entries(
      decodeJson(Schema.Record(Schema.String, Schema.Unknown), manifestText)
    ).filter(([key]) => !omittedFields.has(key))
  );

  yield* fs.writeFileString(
    path.join(output, PACKAGE_MANIFEST_FILE),
    JSON.stringify({
      ...metadata,
      bin: {
        typepeek:
          process.platform === "win32"
            ? "./dist/typepeek.exe"
            : "./dist/typepeek",
      },
      cpu: [process.arch],
      files: ["dist/typepeek*", "LICENSE"],
      os: [process.platform],
    })
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
