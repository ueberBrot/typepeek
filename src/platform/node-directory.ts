import { opendir } from "node:fs/promises";

import { Effect, Stream } from "effect";
import { systemError } from "effect/PlatformError";

export interface DirectoryEntry {
  readonly name: string;
  readonly isBlockDevice: () => boolean;
  readonly isCharacterDevice: () => boolean;
  readonly isFIFO: () => boolean;
  readonly isSocket: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

const directoryError = (directory: string, cause: unknown) =>
  systemError({
    _tag: "Unknown",
    cause,
    method: "readDirectory",
    module: "FileSystem",
    pathOrDescriptor: directory,
  });

export const directoryEntries = (
  directory: string
): Stream.Stream<DirectoryEntry, ReturnType<typeof directoryError>> =>
  Stream.unwrap(
    Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) => directoryError(directory, cause),
        try: async () => await opendir(directory),
      }),
      (handle) =>
        Effect.tryPromise({
          catch: (cause) => directoryError(directory, cause),
          try: async () => {
            await handle.close();
          },
        }).pipe(Effect.ignore)
    ).pipe(
      Effect.map((handle) =>
        Stream.unfold(undefined, () =>
          Effect.tryPromise({
            catch: (cause) => directoryError(directory, cause),
            try: async () => await handle.read(),
          }).pipe(
            Effect.map((entry) =>
              entry === null ? undefined : ([entry, undefined] as const)
            )
          )
        )
      )
    )
  );
