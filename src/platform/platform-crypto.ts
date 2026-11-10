import { layer } from "@effect/platform-bun/BunCrypto";
import { Crypto, Effect } from "effect";
import { Hex } from "effect/encoding";

const encoder = new TextEncoder();
const crypto = Effect.runSync(Crypto.Crypto.pipe(Effect.provide(layer)));

export const sha256 = (value: string): string =>
  Hex.encode(Effect.runSync(crypto.digest("SHA-256", encoder.encode(value))));

export const secureRandomHex = (size: number): string =>
  Hex.encode(Effect.runSync(crypto.randomBytes(size)));

export const secureRandomUUID = (): string =>
  Effect.runSync(crypto.randomUUIDv4());
