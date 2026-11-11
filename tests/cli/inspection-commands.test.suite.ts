import { stripVTControlCharacters } from "node:util";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { decodeJson } from "#typepeek/shared/json-data";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerInspectionCommandTests =
  function registerInspectionCommandTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("compares two Interface Overview indexes through the CLI", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "compare",
        "@typepeek-fixture/conditional",
        "@typepeek-fixture/conditional",
        "--before-workspace",
        getFixture().resolutionContext,
        "--after-workspace",
        getFixture().resolutionContext,
        "--before-access",
        "import",
        "--after-access",
        "require",
      ]);

      expect([
        result.stdout.includes("Public Interface Comparison"),
        result.stdout.includes("Before Access Style: import"),
        result.stdout.includes("After Access Style: require"),
        result.stdout.includes("+ requireExport"),
        result.stdout.includes("- importExport"),
        result.stderr,
      ]).toStrictEqual([true, true, true, true, true, ""]);
    });

    test("renders declaration-only inspection", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "declarations",
        "@typepeek-fixture/focused",
        "createWidget",
        "--workspace",
        getFixture().resolutionContext,
      ]);

      expect([
        result.stdout.includes("Declaration Inspection"),
        result.stdout.includes("Module Export: createWidget"),
        result.stdout.includes("Supporting Types"),
        result.stdout.includes("Signatures"),
      ]).toStrictEqual([true, true, false, false]);
    });

    test("discovers public members with an executable name filter", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "members",
        "@typepeek-fixture/focused",
        "PublicShape",
        "--match",
        "VIS",
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ]);

      expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
        result: {
          intent: "member-discovery",
          memberPath: [],
          members: [{ name: "visible", spaces: ["type"] }],
          moduleExportName: "PublicShape",
          query: "VIS",
          totalMembers: 2,
        },
        status: "success",
      });
    });

    test("discovers nested members and renders their selectors", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "members",
        "@typepeek-fixture/focused",
        "NestedShape",
        '["nested"]',
        "--workspace",
        getFixture().resolutionContext,
      ]);

      expect([
        result.stdout.includes("Member Discovery"),
        result.stdout.includes("Members of: NestedShape.nested"),
        result.stdout.includes("leaf (value)"),
        result.stdout.includes("Declaration Spaces"),
      ]).toStrictEqual([true, true, true, false]);
    });

    test("uses a qualified Member path to select an ambiguous instance member", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "member",
        "@typepeek-fixture/focused",
        "AmbiguousShape",
        '[{"name":"shared","space":"type"}]',
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ]);

      expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
        result: {
          declarations: [{ text: "readonly shared: string;" }],
          memberPath: [{ name: "shared", space: "type" }],
        },
        status: "success",
      });
    });

    test("rejects an invalid Member space through machine diagnostics", async () => {
      const result = await runCommand(
        process.execPath,
        [
          "src/cli.ts",
          "member",
          "@typepeek-fixture/focused",
          "AmbiguousShape",
          '[{"name":"shared","space":"static"}]',
          "--workspace",
          getFixture().resolutionContext,
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
        match.objectContaining({
          status: "invalid-invocation",
        }),
      ]);
    });

    test("renders one exact public member", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "member",
        "@typepeek-fixture/focused",
        "PublicShape",
        "visible",
        "--workspace",
        getFixture().resolutionContext,
      ]);

      expect([
        result.stdout.includes("Member Inspection"),
        result.stdout.includes("Member: PublicShape.visible"),
        result.stdout.includes("readonly visible: VisibleOnly;"),
        result.stdout.includes("private readonly secret"),
      ]).toStrictEqual([true, true, true, false]);
    });

    test("preserves a dotted property name as one exact Member path segment", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "member",
        "@typepeek-fixture/focused",
        "PublicShape",
        "a.b",
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ]);

      expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
        result: {
          intent: "member-inspection",
          memberPath: ["a.b"],
          moduleExportName: "PublicShape",
        },
        status: "success",
      });
    });

    test("accepts an unambiguous JSON array for a nested Member path", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "member",
        "@typepeek-fixture/focused",
        "NestedShape",
        '["nested","leaf"]',
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ]);

      expect(decodeJson(Schema.MutableJson, result.stdout)).toMatchObject({
        result: {
          intent: "member-inspection",
          memberPath: ["nested", "leaf"],
          moduleExportName: "NestedShape",
        },
        status: "success",
      });
    });

    test("searches Module Export names through a focused discovery command", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "search",
        "@typepeek-fixture/focused",
        "error",
        "--workspace",
        getFixture().resolutionContext,
      ]);

      expect([
        result.stdout.includes('Module Exports (3 matching "error";'),
        result.stdout.includes("- ErrorFactory"),
        result.stdout.includes("Public Subpaths"),
      ]).toStrictEqual([true, true, false]);
    });

    test("retrieves signatures from a documentation phrase through discover", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "discover",
        "@typepeek-fixture/focused",
        "creates a widget",
        "--workspace",
        getFixture().resolutionContext,
      ]);

      expect([
        result.stdout.includes("createWidget"),
        result.stdout.includes("(input: WidgetInput): WidgetResult"),
        result.stdout.includes(
          "(input: string, options: WidgetOptions): WidgetResult"
        ),
        result.stdout.includes("untrusted"),
        result.stdout.includes("Supporting Types"),
      ]).toStrictEqual([true, true, true, true, false]);
    });

    test("discovers Public Subpaths without program materialization", async () => {
      const cliArguments = [
        "src/cli.ts",
        "subpaths",
        "@typepeek-fixture/conditional",
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ];

      const result = await runCommand(process.execPath, cliArguments, {
        env: { TYPEPEEK_PROFILE: "1" },
      });

      const profile = decodeJson(
        Schema.Struct({
          phases: Schema.mutableKey(
            Schema.mutable(
              Schema.Array(
                Schema.Struct({
                  name: Schema.mutableKey(Schema.String),
                })
              )
            )
          ),
        }),
        result.stderr
      );

      expect([
        profile.phases
          .map(({ name }) => name)
          .includes("program-materialization"),
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        false,
        match.objectContaining({
          result: match.objectContaining({
            intent: "public-subpath-discovery",
          }),
          status: "success",
        }),
      ]);
    });

    test("keeps a Public Subpath-only inspection plan manifest-only", async () => {
      const result = await runCommand(
        process.execPath,
        [
          "src/cli.ts",
          "plan",
          "@typepeek-fixture/conditional",
          JSON.stringify([
            { intent: "public-subpath-discovery" },
            { intent: "public-subpath-discovery" },
          ]),
          "--workspace",
          getFixture().resolutionContext,
          "--json",
        ],
        { env: { TYPEPEEK_PROFILE: "1" } }
      );

      const profile = decodeJson(
        Schema.Struct({
          phases: Schema.mutableKey(
            Schema.mutable(
              Schema.Array(
                Schema.Struct({
                  name: Schema.mutableKey(Schema.String),
                })
              )
            )
          ),
        }),
        result.stderr
      );

      expect([
        profile.phases
          .map(({ name }) => name)
          .includes("program-materialization"),
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        false,
        match.objectContaining({
          result: match.objectContaining({
            inspections: [
              match.objectContaining({ intent: "public-subpath-discovery" }),
              match.objectContaining({ intent: "public-subpath-discovery" }),
            ],
            intent: "inspection-plan",
          }),
          status: "success",
        }),
      ]);
    });

    test("executes an atomic inspection plan from a bounded JSON query list", async () => {
      const cliArguments = [
        "src/cli.ts",
        "plan",
        "@typepeek-fixture/focused",
        JSON.stringify([
          { intent: "interface-overview" },
          { exportName: "detailed", intent: "signature-inspection" },
        ]),
        "--workspace",
        getFixture().resolutionContext,
        "--json",
      ];

      const result = await runCommand(process.execPath, cliArguments);

      const profiled = await runCommand(process.execPath, cliArguments, {
        env: { TYPEPEEK_PROFILE: "1" },
      });

      expect([result.stderr, profiled.stdout]).toStrictEqual([
        "",
        result.stdout,
      ]);

      const profile = decodeJson(
        Schema.Struct({
          phases: Schema.mutableKey(
            Schema.mutable(
              Schema.Array(
                Schema.Struct({
                  name: Schema.mutableKey(Schema.String),
                })
              )
            )
          ),
        }),
        profiled.stderr
      );

      expect([
        profile.phases.filter(({ name }) => name === "program-materialization")
          .length,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        1,
        match.objectContaining({
          result: match.objectContaining({
            inspections: [
              match.objectContaining({ intent: "interface-overview" }),
              match.objectContaining({
                intent: "signature-inspection",
                moduleExport: match.objectContaining({ name: "detailed" }),
              }),
            ],
            intent: "inspection-plan",
          }),
          status: "success",
        }),
      ]);
    });

    test.each([
      [[], "Inspection Plan queries must contain from 1 through 16 entries."],
      [[null], "Each Inspection Plan query must be an object."],
      [
        [{ intent: "runtime-inspection" }],
        "Each Inspection Plan query has an unsupported intent.",
      ],
      [
        [{ intent: "export-search", query: "" }],
        "Each Export Search query requires a bounded non-empty query string.",
      ],
      [
        [{ intent: "export-inspection" }],
        "Each focused Inspection Plan query requires a string exportName.",
      ],
      [
        [{ exportName: "Example", intent: "member-inspection" }],
        "Each Member Inspection query requires an exportName and memberPath.",
      ],
    ] as const)(
      "preserves the Inspection Plan query diagnostic for %#",
      async (queries, message) => {
        const result = await runCommand(
          process.execPath,
          ["src/cli.ts", "plan", "example", JSON.stringify(queries), "--json"],
          { reject: false }
        );

        expect([
          result.exitCode,
          result.stderr,
          decodeJson(Schema.MutableJson, result.stdout),
        ]).toStrictEqual([
          2,
          "",
          match.objectContaining({
            message: match.stringContaining(message),
            status: "invalid-invocation",
          }),
        ]);
      }
    );

    test("presents root help when invoked without arguments", async () => {
      const result = await runCommand(process.execPath, ["src/cli.ts"]);
      expect([
        result.stdout.includes("USAGE"),
        result.stdout.includes("typepeek overview"),
        result.stderr,
      ]).toStrictEqual([true, true, ""]);
    });

    test("documents every supported Inspectable Module and Access Style", async () => {
      const result = await runCommand(process.execPath, [
        "src/cli.ts",
        "overview",
        "--help",
      ]);

      const helpText = stripVTControlCharacters(result.stdout);

      expect([
        helpText.includes(
          "Package root, Public Subpath, or Node Platform Module"
        ),
        helpText.includes("--access import|require"),
      ]).toStrictEqual([true, true]);
    });
  };
