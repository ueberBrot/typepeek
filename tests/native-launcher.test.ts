import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  launchNative,
  resolveNativeManifest,
} from "#typepeek/distribution/native-launcher";
import {
  hostNativePackage,
  nativePackageName,
} from "#typepeek/distribution/native-platform";
import { processLayer } from "#typepeek/platform/process-runtime";

describe("native distribution selection", () => {
  it.each([
    ["darwin", "arm64", "gnu", "typepeek-darwin-arm64"],
    ["darwin", "x64", "gnu", "typepeek-darwin-x64"],
    ["linux", "arm64", "gnu", "typepeek-linux-arm64-gnu"],
    ["linux", "x64", "gnu", "typepeek-linux-x64-gnu"],
    ["linux", "arm64", "musl", "typepeek-linux-arm64-musl"],
    ["linux", "x64", "musl", "typepeek-linux-x64-musl"],
    ["win32", "x64", "gnu", "typepeek-win32-x64"],
  ] as const)("selects %s %s %s", (platform, architecture, libc, expected) => {
    expect(nativePackageName(platform, architecture, libc)).toBe(expected);
  });

  it.each([
    ["win32", "arm64"],
    ["linux", "ia32"],
    ["freebsd", "x64"],
  ])(
    "retains JavaScript execution for unsupported %s %s",
    (platform, architecture) => {
      expect(nativePackageName(platform, architecture)).toBeUndefined();
    }
  );
});

describe("native launcher installation boundaries", () => {
  let directory: string;
  let name: string;

  beforeAll(async () => {
    directory = await mkdtemp(nodePath.join(tmpdir(), "typepeek-launcher-"));

    const host = await Effect.runPromise(
      hostNativePackage.pipe(Effect.provide(processLayer))
    );

    if (host === undefined) {
      throw new Error(
        "The test host requires a supported native distribution."
      );
    }

    name = host;
  });

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("allows JavaScript execution when optional binaries are omitted", async () => {
    const resolved = await Effect.runPromise(
      resolveNativeManifest(nodePath.join(directory, "entry.js"), name)
    );

    expect(Option.isNone(resolved)).toBeTruthy();
  });

  it("rejects an installed binary from another release", async () => {
    const installation = nodePath.join(
      directory,
      "mismatch",
      "node_modules",
      name
    );

    await mkdir(installation, { recursive: true });
    await writeFile(
      nodePath.join(installation, "package.json"),
      JSON.stringify({ name, version: "0.0.0" })
    );
    await expect(
      Effect.runPromise(
        Effect.scoped(
          launchNative(nodePath.join(directory, "mismatch", "entry.js"), [])
        ).pipe(Effect.provide(processLayer))
      )
    ).rejects.toThrow("incompatible version");
  });

  it("fails rather than masking an installed package with a missing binary", async () => {
    const installation = nodePath.join(
      directory,
      "incomplete",
      "node_modules",
      name
    );

    await mkdir(installation, { recursive: true });
    await writeFile(
      nodePath.join(installation, "package.json"),
      JSON.stringify({ name, version: globalThis.__TYPEPEEK_VERSION__ })
    );
    await expect(
      Effect.runPromise(
        Effect.scoped(
          launchNative(nodePath.join(directory, "incomplete", "entry.js"), [])
        ).pipe(Effect.provide(processLayer))
      )
    ).rejects.toThrow(/ENOENT|NotFound/u);
  });
});
