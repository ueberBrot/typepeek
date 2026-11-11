import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { requireDefined } from "#typepeek/shared/defined-value";
import {
  decodeJson,
  mutableJsonObjectSchema,
} from "#typepeek/shared/json-data";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { profilePhaseNames } from "../helpers/inspection-profile.ts";
import { match } from "../helpers/matchers.ts";

export const registerCacheReuseTests = function registerCacheReuseTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("reuses a validated complete outcome for unchanged Installed Evidence", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-test-")
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

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      const firstPhases = profilePhaseNames(first.stderr);
      const repeatedPhases = profilePhaseNames(repeated.stderr);
      expect([
        repeated.stdout,
        firstPhases.includes("inspection-cache-miss"),
        firstPhases.includes("program-materialization"),
        repeatedPhases.includes("inspection-cache-hit"),
        repeatedPhases.includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, true, true, false]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("caches documentation discovery separately from name-only search", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-discovery-")
    );

    const args = [
      "src/cli.ts",
      "search",
      "@typepeek-fixture/focused",
      "creates a widget",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const names = await runCommand(process.execPath, args, { env });

      const discoveryArgs = [
        requireDefined(args[0]),
        "discover",
        ...args.slice(2),
      ];

      const first = await runCommand(process.execPath, discoveryArgs, {
        env,
      });

      const repeated = await runCommand(process.execPath, discoveryArgs, {
        env,
      });

      expect([
        decodeJson(
          Schema.Struct({
            result: Schema.Struct({ matches: Schema.Array(Schema.Json) }),
          }),
          names.stdout
        ).result.matches,
        decodeJson(Schema.MutableJson, first.stdout),
        profilePhaseNames(first.stderr).includes("inspection-cache-miss"),
        profilePhaseNames(repeated.stderr).includes("inspection-cache-hit"),
        repeated.stdout,
      ]).toStrictEqual([
        [],
        match.objectContaining({
          result: match.objectContaining({
            matches: [match.objectContaining({ name: "createWidget" })],
            scope: "documentation",
          }),
          status: "success",
        }),
        true,
        true,
        first.stdout,
      ]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("reads the versioned authenticated cache wire format through the complete cache-hit path", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-wire-format-test-")
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

      const readdirResult2 = await readdir(cacheDirectory);

      const entryName = readdirResult2.find((name) => name.endsWith(".json"));

      expect(entryName).toBeDefined();

      const entryPath = nodePath.join(
        cacheDirectory,
        requireDefined(entryName)
      );

      const generatedEnvelope = decodeJson(
        mutableJsonObjectSchema,
        await readFile(entryPath, "utf-8")
      );

      const generatedPayload = decodeJson(
        mutableJsonObjectSchema,
        Schema.decodeUnknownSync(Schema.String)(generatedEnvelope["payload"])
      );

      const retainedPayload = JSON.stringify({
        identity: generatedPayload["identity"],
        outcome: generatedPayload["outcome"],
        proof: generatedPayload["proof"],
      });

      const integrityKey = await readFile(
        nodePath.join(cacheDirectory, ".integrity-key"),
        "utf-8"
      );

      await writeFile(
        entryPath,
        JSON.stringify({
          integrity: createHmac("sha256", integrityKey)
            .update(retainedPayload)
            .digest("hex"),
          payload: retainedPayload,
          schemaVersion: 2,
        })
      );

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-hit"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, false]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });

  test("reuses one validated complete atomic Inspection Plan", async () => {
    const cacheDirectory = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cache-plan-test-")
    );

    const cliArguments = [
      "src/cli.ts",
      "plan",
      "@typepeek-fixture/focused",
      JSON.stringify([
        { intent: "interface-overview" },
        { exportName: "createWidget", intent: "signature-inspection" },
      ]),
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

      const repeated = await runCommand(process.execPath, cliArguments, {
        env,
      });

      expect([
        repeated.stdout,
        profilePhaseNames(repeated.stderr).includes("inspection-cache-hit"),
        profilePhaseNames(repeated.stderr).includes("program-materialization"),
      ]).toStrictEqual([first.stdout, true, false]);
    } finally {
      await rm(cacheDirectory, { force: true, recursive: true });
    }
  });
};
