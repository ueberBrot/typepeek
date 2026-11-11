import { layer } from "@effect/platform-bun/BunPath";
import { Effect, Path } from "effect";

export const platformPath = Effect.runSync(
  Path.Path.pipe(Effect.provide(layer))
);
