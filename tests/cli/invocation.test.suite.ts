import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import {
  expectTerminalSafe,
  expectTerminalSafeLine,
  expectJsonTerminalSafe,
} from "../helpers/cli-output.ts";
import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

const assertDeterministicFailure = async function assertDeterministicFailure(
  fixture: CompiledPackageFixture,
  status: string,
  specifier: string,
  message: string
): Promise<void> {
  const cliArguments = [
    "src/cli.ts",
    specifier,
    "--workspace",
    fixture.resolutionContext,
  ];

  const [first, second] = await Promise.all([
    runCommand(process.execPath, cliArguments, { reject: false }),
    runCommand(process.execPath, cliArguments, { reject: false }),
  ]);

  expect([
    Object.is(first.exitCode, 0),
    first.stdout,
    first.stderr,
  ]).toStrictEqual([false, second.stdout, second.stderr]);
  const output = `${first.stdout}\n${first.stderr}`;
  expect(output).toContain(`${status}: ${message}`);
  expectTerminalSafe(output);
};

export const registerInvocationTests = function registerInvocationTests(
  getFixture: () => CompiledPackageFixture
): void {
  test("documents common options on focused commands", async () => {
    const [help, compareHelp] = await Promise.all([
      runCommand(process.execPath, ["src/cli.ts", "signatures", "--help"]),
      runCommand(process.execPath, ["src/cli.ts", "compare", "--help"]),
    ]);

    expect([
      help.stdout.includes("typepeek signatures"),
      help.stdout.includes("<specifier> <export-name>"),
      help.stdout.includes("--workspace path"),
      help.stdout.includes("--context"),
      help.stdout.includes("--json"),
      help.stdout.includes("--pretty"),
      compareHelp.stdout.includes("<before-specifier> <after-specifier>"),
      compareHelp.stdout.includes("--before-workspace path"),
      compareHelp.stdout.includes("--after-workspace path"),
      compareHelp.stdout.includes("--before-context"),
      compareHelp.stdout.includes("--after-context"),
    ]).toStrictEqual([
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test("rejects the removed --context flag", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "overview",
        "@typepeek-fixture/focused",
        "--context",
        getFixture().resolutionContext,
      ],
      { reject: false }
    );

    expect([
      result.exitCode,
      result.stderr.includes("--context"),
    ]).toStrictEqual([2, true]);
  });

  test("explains the capabilities-to-protocol machine workflow", async () => {
    const [capabilitiesHelp, protocolHelp] = await Promise.all([
      runCommand(process.execPath, ["src/cli.ts", "capabilities", "--help"]),
      runCommand(process.execPath, ["src/cli.ts", "protocol", "--help"]),
    ]);

    expect([
      capabilitiesHelp.stdout.includes("Capability output is always JSON"),
      capabilitiesHelp.stdout.includes("machine-mode diagnostics"),
      protocolHelp.stdout.includes("typepeek capabilities --json"),
      protocolHelp.stdout.includes("one compact JSON response"),
    ]).toStrictEqual([true, true, true, true]);
  });

  test.each(["overview", "export", "signatures"])(
    "inspects a package named %s through the explicit overview route",
    async (specifier) => {
      const result = await runCommand(
        process.execPath,
        [
          "src/cli.ts",
          "overview",
          specifier,
          "--workspace",
          getFixture().resolutionContext,
          "--json",
        ],
        { reject: false }
      );

      expect([
        result.exitCode,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        1,
        {
          message: `Specifier "${specifier}" is not installed from this Resolution Context.`,
          reason: "specifier-not-found",
          status: "not-found",
        },
      ]);
    }
  );

  test("escapes option parsing for an export name beginning with a hyphen", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "signatures",
        "@typepeek-fixture/focused",
        "--workspace",
        getFixture().resolutionContext,
        "--",
        "-missing",
      ],
      { reject: false }
    );

    expect([
      Object.is(result.exitCode, 0),
      result.stderr.includes('Module Export "-missing" was not found'),
    ]).toStrictEqual([false, true]);
  });

  test.each([
    [
      "not-found",
      "@typepeek-fixture/not-installed",
      'Specifier "@typepeek-fixture/not-installed" is not installed from this Resolution Context.',
    ],
    [
      "unsupported",
      "@typepeek-fixture/malformed-manifest",
      "The installed package has no valid Package Identity.",
    ],
    [
      "static-boundary",
      "./project-source.d.ts",
      "The requested Specifier is outside the static Inspectable Module boundary.",
    ],
    [
      "limit-exceeded",
      "@typepeek-fixture/broad",
      "Inspection exceeded its Module Export limit.",
    ],
  ] as const)(
    "communicates the %s outcome deterministically",
    async (status, specifier, message) => {
      await expect(
        assertDeterministicFailure(getFixture(), status, specifier, message)
      ).resolves.toBeUndefined();
    }
  );

  test("escapes terminal controls in failed inspection diagnostics", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "missing\u001B[31m-package",
        "--workspace",
        getFixture().resolutionContext,
      ],
      { reject: false }
    );

    expect([
      result.exitCode,
      result.stderr.includes('Specifier "missing\\u{1B}[31m-package"'),
    ]).toStrictEqual([1, true]);
    expectTerminalSafe(result.stderr);
  });

  test("escapes terminal controls in invalid invocation diagnostics", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "overview",
        "example",
        "--access",
        "invalid\u001B[31m\rFORGED\nNEXT\tTAB",
      ],
      { reject: false }
    );

    expect(result.stderr).toContain(
      'Invalid value for flag --access: "invalid\\u{1B}[31m\\u{D}FORGED\\u{A}NEXT\\u{9}TAB"'
    );
    expectTerminalSafeLine(result.stderr);
  });

  test("bounds invalid invocation diagnostics after terminal escaping", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "overview",
        "example",
        "--access",
        "\u001B".repeat(24 * 1024),
      ],
      { reject: false }
    );

    expect([
      result.exitCode,
      Buffer.byteLength(result.stderr) <= 128 * 1024,
      result.stderr.includes("CLI diagnostic exceeded its output limit"),
    ]).toStrictEqual([2, true, true]);
    expectTerminalSafe(result.stderr);
  });

  test("uses the conventional usage exit status for invalid invocations", async () => {
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "signatures", "example"],
      {
        reject: false,
      }
    );

    expect([
      result.exitCode,
      result.stderr.includes("Missing required argument: export-name"),
    ]).toStrictEqual([2, true]);
  });

  test("emits invalid invocations as structured diagnostics in machine mode", async () => {
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "signatures", "example", "--json"],
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
        message: "Missing required argument: export-name",
        status: "invalid-invocation",
      },
    ]);
  });

  test("pretty-prints structured invalid-invocation diagnostics", async () => {
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "signatures", "example", "--json", "--pretty"],
      { reject: false }
    );

    expect([
      result.exitCode,
      result.stderr,
      result.stdout.includes('\n  "status": "invalid-invocation"'),
      decodeJson(Schema.MutableJson, result.stdout),
    ]).toStrictEqual([
      2,
      "",
      true,
      {
        message: "Missing required argument: export-name",
        status: "invalid-invocation",
      },
    ]);
  });

  test("escapes hostile controls in pretty JSON diagnostics", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "src/cli.ts",
        "overview",
        "example",
        "--access",
        "invalid\u001B[31m\rFORGED\nNEXT\tTAB",
        "--json",
        "--pretty",
      ],
      { reject: false }
    );

    expect([result.exitCode, result.stderr, result.stdout]).toStrictEqual([
      2,
      "",
      match.stringMatching(/\\u001[bB]/u),
    ]);
    expectJsonTerminalSafe(result.stdout);
    expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
      status: "invalid-invocation",
    });
  });

  test("accepts common options before an explicit inspection command", async () => {
    const result = await runCommand(process.execPath, [
      "src/cli.ts",
      "--json",
      "--pretty",
      "--workspace",
      getFixture().resolutionContext,
      "signatures",
      "@typepeek-fixture/focused",
      "detailed",
    ]);

    expect([
      result.stderr,
      result.stdout.includes('\n  "status": "success"'),
      decodeJson(Schema.MutableJson, result.stdout),
    ]).toStrictEqual([
      "",
      true,
      match.objectContaining({
        result: match.objectContaining({
          intent: "signature-inspection",
          moduleExport: match.objectContaining({ name: "detailed" }),
          resolutionVariant: match.objectContaining({
            accessStyle: "import",
          }),
        }),
        status: "success",
      }),
    ]);
  });
};
