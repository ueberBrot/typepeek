import { Effect, Stdio, Stream } from "effect";

export const writeStdout = Effect.fnUntraced(function* writeStdout(
  text: string
) {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(text).pipe(Stream.run(stdio.stdout()));
});

export const writeStderr = Effect.fnUntraced(function* writeStderr(
  text: string
) {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(text).pipe(Stream.run(stdio.stderr()));
});
