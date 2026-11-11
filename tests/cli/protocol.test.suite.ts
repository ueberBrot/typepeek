import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { decodeJson } from "#typepeek/shared/json-data";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerProtocolTests = function registerProtocolTests(
  getFixture: () => CompiledPackageFixture
): void {
  test.each([{ flags: [] }, { flags: ["--json"] }])(
    "prints Inspection Core capabilities with optional JSON signaling",
    async ({ flags }) => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "capabilities",
        ...flags,
      ]);

      expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
        intent: "capabilities",
        protocolVersion: "1",
        supportedIntents: match.arrayContaining([
          "inspection-plan",
          "member-inspection",
          "public-interface-comparison",
        ]),
      });
    }
  );

  test("pretty-prints capabilities without changing their JSON value", async () => {
    const [compact, pretty] = await Promise.all([
      runCommand(process.execPath, ["src/cli.ts", "capabilities", "--json"]),
      runCommand(process.execPath, [
        "src/cli.ts",
        "capabilities",
        "--json",
        "--pretty",
      ]),
    ]);

    expect([
      pretty.stderr,
      pretty.stdout.includes('\n  "intent": "capabilities"'),
      decodeJson(Schema.MutableJson, pretty.stdout),
    ]).toStrictEqual([
      "",
      true,
      decodeJson(Schema.MutableJson, compact.stdout),
    ]);
  });

  test("rejects --pretty without --json", async () => {
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "capabilities", "--pretty"],
      {
        reject: false,
      }
    );

    expect([
      result.exitCode,
      result.stdout,
      result.stderr.includes("--pretty requires --json."),
    ]).toStrictEqual([2, "", true]);
  });

  test("invokes the Inspection Protocol through bounded stdin and stdout", async () => {
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "protocol"],
      {
        input: JSON.stringify({
          intent: "signature-inspection",
          protocolVersion: "1",
          request: {
            exportName: "createWidget",
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
        }),
      }
    );

    expect([
      result.exitCode,
      result.stderr,
      decodeJson(Schema.MutableJson, result.stdout),
    ]).toStrictEqual([
      0,
      "",
      match.objectContaining({
        outcome: match.objectContaining({
          result: match.objectContaining({
            intent: "signature-inspection",
            moduleExport: match.objectContaining({ name: "createWidget" }),
          }),
          status: "success",
        }),
        protocolVersion: "1",
      }),
    ]);
  });

  test("returns typed protocol failures on stdout with exit status 1", async () => {
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "protocol"],
      {
        input: JSON.stringify({
          intent: "signature-inspection",
          protocolVersion: "1",
          request: {
            exportName: "MissingExport",
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
        }),
        reject: false,
      }
    );

    expect([
      result.exitCode,
      result.stderr,
      decodeJson(Schema.MutableJson, result.stdout),
    ]).toStrictEqual([
      1,
      "",
      match.objectContaining({
        outcome: match.objectContaining({
          reason: "export-not-found",
          status: "not-found",
        }),
        protocolVersion: "1",
        recovery: [
          match.objectContaining({
            reason: "search-related-export-names",
            request: match.objectContaining({
              intent: "export-search",
              protocolVersion: "1",
            }),
          }),
        ],
      }),
    ]);
  });

  test.each([
    ["\n", "empty-input"],
    ["{", "malformed-json"],
    ["{} {}", "malformed-json"],
  ])(
    "returns one stable wire error for invalid protocol input",
    async (input, reason) => {
      const result = await runCommand(
        process.execPath,
        ["src/cli.ts", "protocol"],
        {
          input,
          reject: false,
        }
      );

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        {
          message: "Typepeek received invalid protocol input.",
          reason,
          status: "invalid-input",
          wireVersion: "1",
        },
      ]);
    }
  );

  test.each([
    [Buffer.alloc(32 * 1024 + 1, 0x20), "input-too-large"],
    [Buffer.from([0xc3, 0x28]), "invalid-utf8"],
  ])(
    "rejects unsafe protocol wire bytes before JSON parsing",
    async (input, reason) => {
      const result = await runCommand(
        process.execPath,
        ["src/cli.ts", "protocol"],
        {
          input,
          reject: false,
        }
      );

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        match.objectContaining({
          reason,
          status: "invalid-input",
          wireVersion: "1",
        }),
      ]);
    }
  );
};
