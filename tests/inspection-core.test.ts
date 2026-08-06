import { execa } from "execa";
import { access } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { inspectInterfaceOverview } from "#typepeek/inspection";

import {
  type CompiledPackageFixture,
  materializeCompiledPackageFixture,
} from "./helpers/compiled-package-fixture.ts";

let fixture: CompiledPackageFixture;

beforeAll(async () => {
  fixture = await materializeCompiledPackageFixture();
}, 30_000);

afterAll(async () => {
  await fixture?.cleanup();
});

it("describes a compiled Package Module without executing its runtime", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/compiled",
  });

  expect(outcome.status).toBe("success");
  if (outcome.status !== "success") {
    return;
  }

  expect(outcome.result.packageIdentity).toEqual({
    name: "@typepeek-fixture/compiled",
    version: "1.2.3",
  });
  expect(outcome.result.moduleExports.map(({ name }) => name)).toEqual([
    "VERSION",
    "WidgetOptions",
    "createWidget",
    "default",
    "dependencyExport",
  ]);
  await expect(access(fixture.runtimeSentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("renders an Interface Overview through the CLI", async () => {
  const result = await execa(process.execPath, [
    "src/cli.ts",
    "@typepeek-fixture/compiled",
    "--context",
    fixture.resolutionContext,
  ]);

  expect(result.stdout).toBe(
    [
      "Interface Overview",
      "Specifier: @typepeek-fixture/compiled",
      "Package: @typepeek-fixture/compiled@1.2.3",
      "Module Exports (5):",
      "- VERSION",
      "- WidgetOptions",
      "- createWidget",
      "- default",
      "- dependencyExport",
    ].join("\n"),
  );
  await expect(access(fixture.runtimeSentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports a limit instead of truncating a broad Module Export index", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/broad",
  });

  expect(outcome).toMatchObject({
    status: "limit-exceeded",
    message: "Inspection exceeded its Module Export limit.",
  });
});

it("rejects an unresolved declaration re-export instead of returning a partial index", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/unresolved",
  });

  expect(outcome).toMatchObject({
    status: "unsupported",
    message: "A declaration re-export could not be resolved from Installed Evidence.",
  });
});

it("follows installed workspace links across Package Module boundaries", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/workspace-main",
  });

  expect(outcome).toMatchObject({
    status: "success",
    result: {
      moduleExports: [{ name: "workspaceDependencyExport" }],
    },
  });
});

it("selects the declaration Resolution Variant for the requested Access Style", async () => {
  const [importOutcome, requireOutcome] = await Promise.all([
    inspectInterfaceOverview({
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/conditional",
      accessStyle: "import",
    }),
    inspectInterfaceOverview({
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/conditional",
      accessStyle: "require",
    }),
  ]);

  expect([importOutcome.status, requireOutcome.status]).toEqual(["success", "success"]);
  if (importOutcome.status !== "success" || requireOutcome.status !== "success") {
    return;
  }
  expect([
    importOutcome.result.moduleExports.map(({ name }) => name),
    requireOutcome.result.moduleExports.map(({ name }) => name),
  ]).toEqual([["importExport"], ["requireExport"]]);
});

it("rejects malformed Package Identity evidence explicitly", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/malformed-manifest",
  });

  expect(outcome).toMatchObject({
    status: "unsupported",
    message: "The installed package has no valid Package Identity.",
  });
});

it("rejects a non-string declared Package Identity version", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/invalid-version",
  });

  expect(outcome).toMatchObject({
    status: "unsupported",
    message: "The installed package has no valid Package Identity.",
  });
});

it("rejects path-like Specifiers before package resolution", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "..",
  });

  expect(outcome).toMatchObject({
    status: "unsupported",
    message: "The initial Interface Overview supports package-root Specifiers only.",
  });
});

it("does not follow declarations into caller project source", async () => {
  const outcome = await inspectInterfaceOverview({
    resolutionContext: fixture.resolutionContext,
    specifier: "@typepeek-fixture/escaping",
  });

  expect(outcome).toMatchObject({
    status: "unsupported",
    message: "A declaration references source outside its installed package boundary.",
  });
});
