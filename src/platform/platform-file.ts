import { Effect, FileSystem } from "effect";

import { collectByteStream } from "#typepeek/shared/byte-stream";

export const readBoundedFileText = Effect.fnUntraced(
  function* readBoundedFileText(fileName: string, maxBytes: number) {
    const fs = yield* FileSystem.FileSystem;

    const bytes = yield* collectByteStream(
      fs.stream(fileName, { bytesToRead: maxBytes + 1 }),
      maxBytes
    );

    return new TextDecoder().decode(bytes);
  }
);
