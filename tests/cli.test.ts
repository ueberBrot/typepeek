import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import { registerCacheAuthorityTests } from "./cli/cache-authority.test.suite.ts";
import { registerCacheEvidenceTests } from "./cli/cache-evidence.test.suite.ts";
import { registerCachePublicationTests } from "./cli/cache-publication.test.suite.ts";
import { registerCacheReuseTests } from "./cli/cache-reuse.test.suite.ts";
import { registerInspectionCommandTests } from "./cli/inspection-commands.test.suite.ts";
import { registerInvocationTests } from "./cli/invocation.test.suite.ts";
import { registerJsonOutputTests } from "./cli/json-output.test.suite.ts";
import { registerProtocolTests } from "./cli/protocol.test.suite.ts";
import { registerTerminalRenderingTests } from "./cli/terminal-rendering.test.suite.ts";
import { registerWorkspaceTests } from "./cli/workspace.test.suite.ts";
import type { CompiledPackageFixture } from "./helpers/compiled-package-fixture.ts";
import { materializeCompiledPackageFixture } from "./helpers/compiled-package-fixture.ts";

describe("cli", () => {
  it("resolves relative workspace flags before invoking the protocol", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "signatures",
        "node:fs",
        "existsSync",
        "--workspace",
        ".",
        "--json",
      ],
      { reject: false }
    );

    expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
      status: "success",
    });
  });

  describe("typepeek CLI", () => {
    let fixture: CompiledPackageFixture;
    beforeAll(async () => {
      fixture = await materializeCompiledPackageFixture();
    }, 120_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it("presents the initial command", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "--help",
      ]);

      expect([
        result.stdout.includes("typepeek"),
        result.stdout.includes("Use overview or search to find exports"),
        result.stdout.includes("overview"),
        result.stdout.includes("export"),
        result.stdout.includes("signatures"),
        result.stdout.includes("plan"),
        result.stdout.includes("search"),
        result.stdout.includes("subpaths"),
        result.stdout.includes("declarations"),
        result.stdout.includes("member"),
        result.stdout.includes("compare"),
        result.stdout.includes("capabilities"),
        result.stdout.includes("protocol"),
      ]).toStrictEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
    });

    it("reports the version declared by the package manifest", async () => {
      const manifest = decodeJson(
        Schema.Struct({
          version: Schema.mutableKey(Schema.String),
        }),
        await readFile(nodePath.join(process.cwd(), "package.json"), "utf-8")
      );

      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "--version",
      ]);

      expect(result.stdout).toContain(manifest.version);
    });

    registerWorkspaceTests();
    registerProtocolTests(() => fixture);
    registerInspectionCommandTests(() => fixture);
    registerTerminalRenderingTests(() => fixture);
    registerCacheReuseTests(() => fixture);
    registerCacheAuthorityTests(() => fixture);
    registerCacheEvidenceTests(() => fixture);
    registerCachePublicationTests(() => fixture);
    registerJsonOutputTests(() => fixture);
    registerInvocationTests(() => fixture);
  });
});
