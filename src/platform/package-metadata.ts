import { layer } from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, Schema } from "effect";

import { platformPath } from "#typepeek/platform/platform-path";

const embeddedTypepeekVersion = globalThis.__TYPEPEEK_VERSION__;

const manifestSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String })
);

const readSourcePackageVersion = Effect.gen(
  function* readSourcePackageVersion() {
    const fs = yield* FileSystem.FileSystem;

    const path = yield* platformPath.fromFileUrl(
      new URL("../../package.json", import.meta.url)
    );

    const text = yield* fs.readFileString(path);
    const manifest = yield* Schema.decodeEffect(manifestSchema)(text);

    return manifest.version;
  }
);

export const TYPEPEEK_VERSION =
  embeddedTypepeekVersion ??
  (await Effect.runPromise(
    readSourcePackageVersion.pipe(Effect.provide(layer))
  ));

export const HAS_EMBEDDED_TYPEPEEK_VERSION =
  embeddedTypepeekVersion !== undefined;
