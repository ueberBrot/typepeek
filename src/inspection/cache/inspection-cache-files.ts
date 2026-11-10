import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";

import type { InspectionCacheEnvelope } from "#typepeek/inspection/cache/inspection-cache-codec";
import {
  CACHE_SCHEMA_VERSION,
  encodeInspectionCacheEnvelope,
  MAX_CACHE_ENTRY_BYTES,
  readInspectionCacheEnvelope,
  readInspectionCacheKey,
  readInspectionCachePath,
} from "#typepeek/inspection/cache/inspection-cache-codec";
import { readBoundedUtf8File } from "#typepeek/inspection/evidence/evidence-boundary";
import { HAS_EMBEDDED_TYPEPEEK_VERSION } from "#typepeek/platform/package-metadata";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";
import { decodeJson } from "#typepeek/shared/json-data";

const MAX_CACHE_DIRECTORY_ENTRIES = 256;

const configuredCacheDirectory = function configuredCacheDirectory():
  | string
  | undefined {
  if (process.platform === "win32") {
    return undefined;
  }

  const explicit = process.env["TYPEPEEK_CACHE_DIRECTORY"];

  if (explicit !== undefined) {
    return readInspectionCachePath(explicit);
  }

  if (process.env.NODE_ENV === "test" || !HAS_EMBEDDED_TYPEPEEK_VERSION) {
    return undefined;
  }

  return nodePath.join(
    tmpdir(),
    `typepeek-${process.getuid?.() ?? "user"}`,
    `inspection-cache-v${CACHE_SCHEMA_VERSION}`
  );
};

const isPrivateOwned = function isPrivateOwned(metadata: Stats): boolean {
  const userId = process.getuid?.();

  return (
    (userId === undefined || metadata.uid === userId) &&
    bitwiseAnd(metadata.mode, 0o077) === 0
  );
};

const isPrivateOwnedDirectory = function isPrivateOwnedDirectory(
  metadata: Stats
): boolean {
  return metadata.isDirectory() && isPrivateOwned(metadata);
};

const isUsableCacheDirectory = function isUsableCacheDirectory(
  metadata: Stats
): boolean {
  return isPrivateOwnedDirectory(metadata) && !metadata.isSymbolicLink();
};

const prepareCacheDirectory = function prepareCacheDirectory(
  directory: string
): void {
  if (existsSync(directory)) {
    const metadata = lstatSync(directory);

    if (!isUsableCacheDirectory(metadata)) {
      throw new Error(
        "Inspection cache directory is not a private owned directory."
      );
    }

    return;
  }

  mkdirSync(directory, { mode: 0o700, recursive: true });
  const metadata = lstatSync(directory);

  if (!isUsableCacheDirectory(metadata)) {
    throw new Error(
      "Inspection cache directory could not be created privately."
    );
  }
};

const prepareAndReadCacheDirectory = function prepareAndReadCacheDirectory(
  directory: string,
  create: boolean
): string | undefined {
  try {
    if (create) {
      prepareCacheDirectory(directory);
    }

    const metadata = lstatSync(directory);

    return isUsableCacheDirectory(metadata) ? directory : undefined;
  } catch {
    return undefined;
  }
};

const cacheDirectory = function cacheDirectory(
  create: boolean
): string | undefined {
  const directory = configuredCacheDirectory();

  return directory === undefined
    ? undefined
    : prepareAndReadCacheDirectory(directory, create);
};

const cacheEntryPath = function cacheEntryPath(
  key: string,
  create: boolean
): string | undefined {
  const directory = cacheDirectory(create);

  return directory === undefined
    ? undefined
    : nodePath.join(directory, `${key}.json`);
};

export const removeInspectionCacheEntry = function removeInspectionCacheEntry(
  key: string
): void {
  if (readInspectionCacheKey(key) === undefined) {
    return;
  }

  const path = cacheEntryPath(key, false);

  if (path === undefined) {
    return;
  }

  try {
    const metadata = lstatSync(path);

    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      unlinkSync(path);
    }
  } catch {
    /* Cache persistence and cleanup are best effort. */
  }
};

const withCacheWriteLock = function withCacheWriteLock(
  directory: string,
  write: () => void
): void {
  const lockPath = nodePath.join(directory, ".write-lock");

  try {
    writeFileSync(lockPath, String(process.pid), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    return;
  }

  try {
    try {
      write();
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  }
};

const cacheDirectoryHasCapacity = function cacheDirectoryHasCapacity(
  entryPath: string
): boolean {
  if (existsSync(entryPath)) {
    return true;
  }

  const directory = opendirSync(nodePath.dirname(entryPath));
  let count = 0;

  try {
    while (directory.readSync() !== null) {
      count += 1;

      if (count >= MAX_CACHE_DIRECTORY_ENTRIES) {
        return false;
      }
    }

    return true;
  } finally {
    directory.closeSync();
  }
};

const isPrivateOwnedFile = function isPrivateOwnedFile(
  metadata: Stats
): boolean {
  return metadata.isFile() && isPrivateOwned(metadata);
};

const readIntegrityKey = function readIntegrityKey(
  directory: string,
  create: boolean
): string | undefined {
  const keyPath = nodePath.join(directory, ".integrity-key");

  if (create && !existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32).toString("hex"), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  }

  try {
    const metadata = lstatSync(keyPath);

    if (
      !isPrivateOwnedFile(metadata) ||
      metadata.isSymbolicLink() ||
      metadata.size !== 64
    ) {
      return undefined;
    }

    const key = readBoundedUtf8File(
      keyPath,
      64,
      "compiler-host-bytes",
      "Inspection cache integrity key exceeded its byte limit."
    );

    return readInspectionCacheKey(key);
  } catch {
    return undefined;
  }
};

const cacheIntegrity = function cacheIntegrity(
  key: string,
  payload: string
): string {
  return createHmac("sha256", key).update(payload).digest("hex");
};

const writeAtomically = function writeAtomically(
  path: string,
  serialized: string
): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      /* Cache persistence and cleanup are best effort. */
    }
  }
};

/** Publishes an authenticated entry, serializing its payload only after storage is ready. */
export const writeInspectionCacheFile = function writeInspectionCacheFile(
  key: string,
  serializePayload: () => string
): void {
  const path = cacheEntryPath(key, true);

  if (path === undefined) {
    return;
  }

  withCacheWriteLock(nodePath.dirname(path), () => {
    if (!cacheDirectoryHasCapacity(path)) {
      return;
    }

    const integrityKey = readIntegrityKey(nodePath.dirname(path), true);

    if (integrityKey === undefined) {
      return;
    }

    const serializedPayload = serializePayload();

    const envelope = encodeInspectionCacheEnvelope({
      integrity: cacheIntegrity(integrityKey, serializedPayload),
      payload: serializedPayload,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });

    if (envelope === undefined) {
      return;
    }

    const serialized = JSON.stringify(envelope);

    if (Buffer.byteLength(serialized) > MAX_CACHE_ENTRY_BYTES) {
      return;
    }

    writeAtomically(path, serialized);
  });
};

const isReadableCacheEntry = function isReadableCacheEntry(
  metadata: Stats
): boolean {
  return (
    isPrivateOwnedFile(metadata) &&
    !metadata.isSymbolicLink() &&
    metadata.size <= MAX_CACHE_ENTRY_BYTES
  );
};

const readCacheEnvelope = function readCacheEnvelope(
  path: string
): InspectionCacheEnvelope | undefined {
  const metadata = lstatSync(path);

  if (!isReadableCacheEntry(metadata)) {
    return undefined;
  }

  const value = decodeJson(
    Schema.Unknown,
    readBoundedUtf8File(
      path,
      MAX_CACHE_ENTRY_BYTES,
      "compiler-host-bytes",
      "Inspection cache entry exceeded its byte limit."
    )
  );

  return readInspectionCacheEnvelope(value);
};

const integritiesEqual = function integritiesEqual(
  left: string,
  right: string
): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const cacheEnvelopeIntegrityMatches = function cacheEnvelopeIntegrityMatches(
  envelope: InspectionCacheEnvelope,
  integrityKey: string
): boolean {
  return integritiesEqual(
    envelope.integrity,
    cacheIntegrity(integrityKey, envelope.payload)
  );
};

const readAuthenticatedCachePayload = function readAuthenticatedCachePayload(
  path: string,
  envelope: InspectionCacheEnvelope
): Schema.Json | undefined {
  const integrityKey = readIntegrityKey(nodePath.dirname(path), false);

  if (
    integrityKey === undefined ||
    !cacheEnvelopeIntegrityMatches(envelope, integrityKey)
  ) {
    return undefined;
  }

  return decodeJson(Schema.Json, envelope.payload);
};

/** Returns payload data only after bounded envelope validation and constant-time authentication. */
export const readAuthenticatedInspectionCacheFile =
  function readAuthenticatedInspectionCacheFile(
    key: string
  ): Schema.Json | undefined {
    const path = cacheEntryPath(key, false);

    if (path === undefined) {
      return undefined;
    }

    try {
      const envelope = readCacheEnvelope(path);

      return envelope === undefined
        ? undefined
        : readAuthenticatedCachePayload(path, envelope);
    } catch {
      return undefined;
    }
  };
