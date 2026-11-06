import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { profilePhaseNames } from "../helpers/inspection-profile.ts";
import { match } from "../helpers/matchers.ts";

export const registerCachePublicationTests =
  function registerCachePublicationTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("does not cache a failed inspection outcome", async () => {
      const cacheDirectory = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-cache-failure-test-")
      );

      const cliArguments = [
        "src/cli.ts",
        "export",
        "@typepeek-fixture/focused",
        "missingExport",
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ];

      const env = {
        TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
        TYPEPEEK_PROFILE: "1",
      };

      try {
        const first = await runCommand(process.execPath, cliArguments, {
          env,
          reject: false,
        });

        const repeated = await runCommand(process.execPath, cliArguments, {
          env,
          reject: false,
        });

        const readdirResult6 = await readdir(cacheDirectory);
        expect([
          decodeJson(Schema.MutableJson, first.stdout),
          repeated.stdout,
          profilePhaseNames(first.stderr).includes("inspection-cache-miss"),
          profilePhaseNames(repeated.stderr).includes("inspection-cache-miss"),
          readdirResult6.some((name) => name.endsWith(".json")),
        ]).toStrictEqual([
          match.objectContaining({ status: "not-found" }),
          first.stdout,
          true,
          true,
          false,
        ]);
      } finally {
        await rm(cacheDirectory, { force: true, recursive: true });
      }
    });

    test("publishes one valid cache entry under concurrent identical inspections", async () => {
      const cacheDirectory = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-cache-concurrency-test-")
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
        const concurrent = await Promise.all(
          Array.from(
            { length: 4 },
            async () =>
              await runCommand(process.execPath, cliArguments, { env })
          )
        );

        const repeated = await runCommand(process.execPath, cliArguments, {
          env,
        });

        const readdirResult7 = await readdir(cacheDirectory);

        const entryNames = readdirResult7.filter((name) =>
          name.endsWith(".json")
        );

        expect(entryNames).toHaveLength(1);

        const serializedEntry = await readFile(
          nodePath.join(cacheDirectory, requireDefined(entryNames[0])),
          "utf-8"
        );

        expect([
          new Set(concurrent.map(({ stdout }) => stdout)).size,
          repeated.stdout,
          profilePhaseNames(repeated.stderr).includes("inspection-cache-hit"),
        ]).toStrictEqual([1, concurrent[0]?.stdout, true]);
        expect(() =>
          decodeJson(Schema.MutableJson, serializedEntry)
        ).not.toThrow();
      } finally {
        await rm(cacheDirectory, { force: true, recursive: true });
      }
    });
  };
