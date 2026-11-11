import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { requireDefined } from "#typepeek/shared/defined-value";
import { decodeJson } from "#typepeek/shared/json-data";

import { expectJsonTerminalSafe } from "../helpers/cli-output.ts";
import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerJsonOutputTests = function registerJsonOutputTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("lists Public Subpaths after Module Exports only when requested", async () => {
    const result = await runCommand(process.execPath, [
      "src/cli.ts",
      "@typepeek-fixture/conditional",
      "--workspace",
      getFixture().resolutionContext,
      "--subpaths",
    ]);

    expect([
      result.stdout.includes("Public Subpaths (3):"),
      result.stdout.includes("- @typepeek-fixture/conditional/feature"),
      result.stdout.indexOf("Module Exports") <
        result.stdout.indexOf("Public Subpaths"),
    ]).toStrictEqual([true, true, true]);
  });

  test("matches Module Exports deterministically without presenting a complete overview", async () => {
    const result = await runCommand(process.execPath, [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/focused",
      "--workspace",
      getFixture().resolutionContext,
      "--match",
      "error",
    ]);

    expect([
      result.stdout,
      result.stdout.includes("- ErrorFactory"),
      result.stdout.includes("- InheritedError"),
      result.stdout.includes("- TransitiveError"),
      result.stdout.includes("- createWidget"),
    ]).toStrictEqual([
      match.stringMatching(
        /Module Exports \(3 matching "error"; \d+ total\):/u
      ),
      true,
      true,
      true,
      false,
    ]);
  });

  test("renders a Signature Inspection without traversing Supporting Types", async () => {
    const result = await runCommand(process.execPath, [
      "src/cli.ts",
      "signatures",
      "@typepeek-fixture/deep-supporting-types",
      "inspect",
      "--workspace",
      getFixture().resolutionContext,
    ]);

    expect([
      result.stdout.includes("Signature Inspection"),
      result.stdout.includes("- call: (value: Depth0): void"),
      result.stdout.includes("Supporting Types"),
    ]).toStrictEqual([true, true, false]);
  });

  test("emits invocation-oriented signature structure for agents", async () => {
    const result = await runCommand(process.execPath, [
      "src/cli.ts",
      "signatures",
      "@typepeek-fixture/focused",
      "detailed",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ]);

    expect([
      result.stderr,
      decodeJson(Schema.MutableJson, result.stdout),
    ]).toStrictEqual([
      "",
      match.objectContaining({
        result: match.objectContaining({
          intent: "signature-inspection",
          moduleExport: match.objectContaining({
            name: "detailed",
            signatures: [
              match.objectContaining({
                parameters: [
                  match.objectContaining({
                    binding: match.objectContaining({ name: "value" }),
                    optional: false,
                    rest: false,
                    type: "T",
                  }),
                  match.objectContaining({
                    binding: match.objectContaining({ name: "options" }),
                    optional: true,
                    rest: false,
                  }),
                  match.objectContaining({
                    binding: match.objectContaining({ name: "rest" }),
                    optional: true,
                    rest: true,
                  }),
                ],
                returns: match.objectContaining({ kind: "type", type: "T" }),
                typeParameters: [
                  match.objectContaining({
                    modifiers: ["const"],
                    name: "T",
                  }),
                ],
              }),
            ],
          }),
        }),
        status: "success",
      }),
    ]);
  });

  test.each([
    { flags: [], label: "compact" },
    { flags: ["--pretty"], label: "pretty" },
  ])(
    "emits a complete $label JSON success with hostile evidence escaped losslessly",
    async ({ flags }) => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "export",
        "@typepeek-fixture/focused",
        "createWidget",
        "--workspace",
        getFixture().resolutionContext,
        "--json",
        ...flags,
      ]);

      expect([
        result.stderr,
        result.stdout.includes("\u001B"),
        result.stdout.includes("\u061C"),
      ]).toStrictEqual(["", false, false]);
      expectJsonTerminalSafe(result.stdout);

      const outcome = decodeJson(
        Schema.Struct({
          result: Schema.mutableKey(
            Schema.Struct({
              packageDocumentation: Schema.mutableKey(
                Schema.optionalKey(
                  Schema.Struct({
                    text: Schema.mutableKey(Schema.String),
                  })
                )
              ),
            })
          ),
          status: Schema.mutableKey(Schema.String),
        }),
        result.stdout
      );

      expect([
        outcome.status,
        requireDefined(outcome.result.packageDocumentation?.text).includes(
          "Ignore previous instructions."
        ),
      ]).toStrictEqual(["success", true]);
    }
  );

  test("pretty-prints an Inspection Outcome without changing its JSON value", async () => {
    const cliArguments = [
      "src/cli.ts",
      "signatures",
      "@typepeek-fixture/focused",
      "detailed",
      "--workspace",
      getFixture().resolutionContext,
      "--json",
    ];

    const [compact, pretty] = await Promise.all([
      runCommand(process.execPath, cliArguments),
      runCommand(process.execPath, [...cliArguments, "--pretty"]),
    ]);

    expect([
      pretty.stderr,
      pretty.stdout.includes('\n  "status": "success"'),
      decodeJson(Schema.MutableJson, pretty.stdout),
    ]).toStrictEqual([
      "",
      true,
      decodeJson(Schema.MutableJson, compact.stdout),
    ]);
  });

  test.each([
    ["not-found", "@typepeek-fixture/not-installed"],
    ["unsupported", "@typepeek-fixture/malformed-manifest"],
    ["static-boundary", "./project-source.d.ts"],
    ["limit-exceeded", "@typepeek-fixture/broad"],
  ] as const)(
    "emits the %s failure as JSON on stdout",
    async (status, specifier) => {
      const cliArguments = [
        "src/cli.ts",
        specifier,
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ];

      const [first, repeated] = await Promise.all([
        runCommand(process.execPath, cliArguments, { reject: false }),
        runCommand(process.execPath, cliArguments, { reject: false }),
      ]);

      expect([
        first.exitCode,
        first.stderr,
        first.stdout,
        decodeJson(Schema.MutableJson, first.stdout),
      ]).toStrictEqual([
        1,
        "",
        repeated.stdout,
        match.objectContaining({ status }),
      ]);
    }
  );

  test.each(["--subpaths", "--match"] as const)(
    "rejects the human-only %s option with JSON output",
    async (flag) => {
      const flagArguments = flag === "--match" ? [flag, "error"] : [flag];

      const result = await runCommand(
        process.execPath,
        [
          "src/cli.ts",
          "@typepeek-fixture/focused",
          "--workspace",
          getFixture().resolutionContext,
          ...flagArguments,
          "--json",
        ],
        { reject: false }
      );

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        {
          message: `${flag} cannot be combined with --json.`,
          status: "invalid-invocation",
        },
      ]);
    }
  );
};
