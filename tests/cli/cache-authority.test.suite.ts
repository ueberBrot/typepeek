import { createHmac } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { bitwiseAnd } from "#typepeek/integer-bits";
import { decodeJson, mutableJsonObjectSchema } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { profilePhaseNames } from "../helpers/inspection-profile.ts";
import { match } from "../helpers/matchers.ts";

const mutableCachePayloadSchema = Schema.Struct({
  outcome: Schema.mutableKey(mutableJsonObjectSchema),
});

type MutableCachePayload = typeof mutableCachePayloadSchema.Type;

const cachedSuccessResult = function cachedSuccessResult(
  payload: MutableCachePayload
): Schema.MutableJsonObject {
  const { result } = payload.outcome;

  if (!Schema.is(mutableJsonObjectSchema)(result)) {
    throw new Error("The cached success must contain a result object.");
  }

  return result;
};

const mutateAuthenticatedCachePayload =
  async function mutateAuthenticatedCachePayload(
    cacheDirectory: string,
    mutate: (payload: MutableCachePayload) => void
  ): Promise<void> {
    const readdirResult = await readdir(cacheDirectory);

    const entryName = readdirResult.find((name) => name.endsWith(".json"));

    expect(entryName).toBeDefined();
    const entryPath = nodePath.join(cacheDirectory, requireDefined(entryName));

    const envelope = decodeJson(
      Schema.Struct({
        integrity: Schema.mutableKey(Schema.String),
        payload: Schema.mutableKey(Schema.String),
      }),
      await readFile(entryPath, "utf-8")
    );

    const payload = decodeJson(mutableCachePayloadSchema, envelope.payload);

    mutate(payload);
    const serializedPayload = JSON.stringify(payload);

    const integrityKey = await readFile(
      nodePath.join(cacheDirectory, ".integrity-key"),
      "utf-8"
    );

    envelope.payload = serializedPayload;
    envelope.integrity = createHmac("sha256", integrityKey)
      .update(serializedPayload)
      .digest("hex");
    await writeFile(entryPath, JSON.stringify(envelope));
  };

export const registerCacheAuthorityTests = function registerCacheAuthorityTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("ignores a corrupted cached outcome instead of treating it as authority", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-corruption-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });

      const readdirResult3 = await readdir(cacheDirectory);

      const entryName = readdirResult3.find((name) => name.endsWith(".json"));

      expect(entryName).toBeDefined();

      const entryPath = nodePath.join(
        cacheDirectory,
        requireDefined(entryName)
      );

      const envelope = decodeJson(
        mutableJsonObjectSchema,
        await readFile(entryPath, "utf-8")
      );

      const payload = decodeJson(
        mutableJsonObjectSchema,
        Schema.decodeUnknownSync(Schema.String)(envelope["payload"])
      );

      payload["outcome"] = {
        result: { intent: "interface-overview" },
        status: "success",
      };
      envelope["payload"] = JSON.stringify(payload);
      await writeFile(entryPath, JSON.stringify(envelope));

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, true]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("ignores an authenticated non-success cache entry", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-failure-entry-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        payload.outcome = {
          message: "authenticated stale failure",
          reason: "export-not-found",
          status: "not-found",
        };
      });

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, true]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("rejects an authenticated cached success for a different request", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-request-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        const result = cachedSuccessResult(payload);

        result["specifier"] = "authenticated-wrong-specifier";
      });

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("rejects an authenticated cached success for different Installed Evidence", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-identity-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        const result = cachedSuccessResult(payload);
        const identity = result["packageIdentity"];

        if (!Schema.is(mutableJsonObjectSchema)(identity)) {
          throw new Error(
            "A cached package result must have its Package Identity."
          );
        }

        identity["name"] = "authenticated-wrong-package";
      });

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, true]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("rejects an authenticated cached success beyond the process result limit", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-output-limit-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await runCommand(process.execPath, cliArguments, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        const result = cachedSuccessResult(payload);

        result["packageDocumentation"] = {
          provenance: "installed-evidence",
          text: "x".repeat(70 * 1024),
          trust: "untrusted",
        };
      });

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, true]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("keeps a successful outcome when optional cache storage is unavailable", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-write-failure-test-")
    );

    await mkdir(nodePath.join(cacheDirectory, ".write-lock"));

    try {
      const result = await runCommand(
        process.execPath,
        [
          "src/cli.ts",
          "overview",
          "@typepeek-fixture/focused",
          "--workspace",
          getFixture().resolutionContext,
          "--json",
        ],
        {
          env: { TYPEPEEK_CACHE_DIRECTORY: cacheDirectory },
        }
      );

      const readdirResult4 = await readdir(cacheDirectory);
      expect([
        decodeJson(Schema.MutableJson, result.stdout),
        readdirResult4.filter((name) => name.endsWith(".json")),
      ]).toStrictEqual([match.objectContaining({ status: "success" }), []]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "does not mutate or use a symlinked cache directory",
    async () => {
      const root = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-cache-symlink-test-")
      );

      const target = nodePath.join(root, "target");
      const cacheDirectory = nodePath.join(root, "cache");
      await mkdir(target, { mode: 0o755 });
      await symlink(target, cacheDirectory, "dir");
      const statResult = await stat(target);
      const modeBefore = bitwiseAnd(statResult.mode, 0o777);

      try {
        const result = await runCommand(
          process.execPath,
          [
            "src/cli.ts",
            "overview",
            "@typepeek-fixture/focused",
            "--workspace",
            getFixture().resolutionContext,
            "--json",
          ],
          {
            env: { TYPEPEEK_CACHE_DIRECTORY: cacheDirectory },
          }
        );

        const statResult2 = await stat(target);
        expect([
          decodeJson(Schema.MutableJson, result.stdout),
          bitwiseAnd(statResult2.mode, 0o777),
        ]).toStrictEqual([
          match.objectContaining({
            status: "success",
          }),
          modeBefore,
        ]);
        await expect(readdir(target)).resolves.toStrictEqual([]);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );
};
