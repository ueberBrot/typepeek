import { createWriteStream } from "node:fs";

import { fromWritable } from "@effect/platform-node-shared/NodeSink";
import { Stream } from "effect";
import { systemError } from "effect/PlatformError";

export const writeAnalysisMetadata = (text: string) =>
  Stream.make(text).pipe(
    Stream.run(
      fromWritable({
        endOnDone: true,
        evaluate: () => createWriteStream("", { fd: 3 }),
        onError: (cause) =>
          systemError({
            _tag: "Unknown",
            cause,
            method: "writeAnalysisMetadata",
            module: "FileSystem",
          }),
      })
    )
  );
