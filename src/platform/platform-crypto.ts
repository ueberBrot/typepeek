import { layerDigest, layerSecureRandom } from "@effect/platform-bun/BunCrypto";
import { Effect } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

const encoder = new TextEncoder();
const digest = Effect.runSync(Digest.Digest.pipe(Effect.provide(layerDigest)));

const secureRandom = Effect.runSync(
  SecureRandom.SecureRandom.pipe(Effect.provide(layerSecureRandom))
);

export const sha256 = (value: string): string =>
  Effect.runSync(digest.digestHex(Digest.sha256, encoder.encode(value)));

export const secureRandomHex = (size: number): string =>
  Hex.encode(Effect.runSync(secureRandom.randomBytes(size)));

export const secureRandomUUID = (): string =>
  Effect.runSync(secureRandom.uuidV4());
