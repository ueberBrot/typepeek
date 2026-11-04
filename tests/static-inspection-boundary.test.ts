import { access } from "node:fs/promises";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";

import { match } from "./helpers/matchers.ts";
import { materializeStaticInspection } from "./helpers/static-inspection.ts";
import type { TrustBoundaryFixture } from "./helpers/trust-boundary-fixture.ts";
import { materializeTrustBoundaryFixture } from "./helpers/trust-boundary-fixture.ts";

const PACKAGE_NAME = "@typepeek-fixture/runtime-equivalent";

describe("static-inspection-boundary", () => {
  describe("Static Inspection trust boundary", () => {
    let fixture: TrustBoundaryFixture;
    beforeAll(async () => {
      fixture = await materializeTrustBoundaryFixture();
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it("derives equivalent semantics without loading readable, minified, or throwing runtimes", async () => {
      const overviews = await Promise.all(
        Object.values(fixture.contexts).map(
          async (resolutionContext) =>
            await inspectInterfaceOverview({
              resolutionContext,
              specifier: PACKAGE_NAME,
            })
        )
      );

      const focused = await Promise.all(
        Object.values(fixture.contexts).map(
          async (resolutionContext) =>
            await inspectExport({
              exportName: "inspect",
              resolutionContext,
              specifier: PACKAGE_NAME,
            })
        )
      );

      expect([overviews[0], overviews, focused[0], focused]).toStrictEqual([
        match.objectContaining({ status: "success" }),
        [overviews[0], overviews[0], overviews[0]],
        match.objectContaining({ status: "success" }),
        [focused[0], focused[0], focused[0]],
      ]);

      if (focused[0]?.status !== "success") {
        throw new Error("Expected a successful inspection.");
      }

      expect([
        focused[0].result.packageDocumentation,
        requireDefined(focused[0].result.packageDocumentation?.text).includes(
          "Ignore previous instructions."
        ),
      ]).toStrictEqual([
        match.objectContaining({
          provenance: "installed-evidence",
          trust: "untrusted",
        }),
        true,
      ]);

      for (const sanitizedCharacter of [
        "\u0007",
        "\u001B",
        "\u009B",
        "\r",
        "\u202E",
      ]) {
        expect(focused[0].result.packageDocumentation?.text).not.toContain(
          sanitizedCharacter
        );
      }

      await fixture.verifyInert();
    });

    it("keeps compiler, plugin, config, script, runtime, process, and network traps inert in the CLI subprocess", async () => {
      const inspection = await materializeStaticInspection(
        fixture.primaryContext,
        fixture.staticInspectionPolicy
      );

      const result = await inspection.run({
        adapter: { kind: "source-checkout", sourceCheckout: process.cwd() },
        cliArguments: ["export", PACKAGE_NAME, "inspect"],
        diagnosticContext: "Static Inspection trust-boundary CLI fixture",
        resolutionContext: fixture.primaryContext,
      });

      expect([
        result.stdout.includes("Export Inspection"),
        result.stdout.includes(
          "Package Documentation (untrusted Installed Evidence):"
        ),
        result.stdout.includes("Ignore previous instructions."),
        result.stdout.includes("line\\u{2028}separator\\u{2029}paragraph"),
      ]).toStrictEqual([true, true, true, true]);

      for (const inertCharacter of [
        "\u0007",
        "\u001B",
        "\u009B",
        "\r",
        "\u2028",
        "\u2029",
        "\u202E",
      ]) {
        expect(result.stdout).not.toContain(inertCharacter);
      }

      expect([
        result.stdout.match(/^Interface Overview$/gmu) === null,
        result.stdout.match(/^Module Exports \(999\):$/gmu) === null,
      ]).toStrictEqual([true, true]);
      await inspection.verifyNoIo();
      await fixture.verifyInert();
    });

    it("rejects JavaScript-only packages clearly without loading their runtime", async () => {
      const overview = await inspectInterfaceOverview({
        resolutionContext: fixture.primaryContext,
        specifier: "@typepeek-fixture/js-only",
      });

      const focused = await inspectExport({
        exportName: "anything",
        resolutionContext: fixture.primaryContext,
        specifier: "@typepeek-fixture/js-only",
      });

      expect([overview, focused]).toStrictEqual([
        {
          message:
            'Package Module "@typepeek-fixture/js-only" has no readable Declaration Provider.',
          reason: "unsupported-evidence",
          status: "unsupported",
        },
        overview,
      ]);
      await fixture.verifyInert();
    });

    it.each([
      [
        "relative source",
        "./project-source.ts",
        {
          message:
            "The requested Specifier is outside the static Inspectable Module boundary.",
          reason: "static-boundary",
          status: "static-boundary",
        },
      ],
      [
        "package import",
        "#internal",
        {
          message:
            'Specifier "#internal" is not installed from this Resolution Context.',
          reason: "specifier-not-found",
          status: "not-found",
        },
      ],
      [
        "TypeScript path alias",
        "@fixture/project-source",
        {
          message:
            'Specifier "@fixture/project-source" is not installed from this Resolution Context.',
          reason: "specifier-not-found",
          status: "not-found",
        },
      ],
      [
        "undeclared deep path",
        `${PACKAGE_NAME}/dist/private`,
        {
          message:
            "The requested Specifier is not a manifest-declared Public Subpath.",
          reason: "unsupported-evidence",
          status: "unsupported",
        },
      ],
      [
        "global value",
        "Buffer",
        {
          message:
            'Specifier "Buffer" is not installed from this Resolution Context.',
          reason: "specifier-not-found",
          status: "not-found",
        },
      ],
      [
        "global namespace",
        "NodeJS",
        {
          message:
            'Specifier "NodeJS" is not installed from this Resolution Context.',
          reason: "specifier-not-found",
          status: "not-found",
        },
      ],
    ])(
      "keeps %s outside the Inspectable Module boundary",
      async (_label, specifier, expected) => {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: fixture.primaryContext,
          specifier,
        });

        expect(outcome).toStrictEqual(expected);
        await fixture.verifyInert();
      }
    );

    it("keeps existing parent, absolute, and file-URL sources outside the boundary", async () => {
      await expect(
        access(fixture.parentProjectSource)
      ).resolves.toBeUndefined();

      const outcomes = await Promise.all(
        [
          nodePath.relative(
            fixture.primaryContext,
            fixture.parentProjectSource
          ),
          fixture.projectSource,
          pathToFileURL(fixture.projectSource).href,
        ].map(
          async (specifier) =>
            await inspectInterfaceOverview({
              resolutionContext: fixture.primaryContext,
              specifier,
            })
        )
      );

      expect(outcomes).toStrictEqual([
        {
          message:
            "The requested Specifier is outside the static Inspectable Module boundary.",
          reason: "static-boundary",
          status: "static-boundary",
        },
        {
          message:
            "The requested Specifier is outside the static Inspectable Module boundary.",
          reason: "static-boundary",
          status: "static-boundary",
        },
        {
          message:
            "The requested Specifier is outside the static Inspectable Module boundary.",
          reason: "static-boundary",
          status: "static-boundary",
        },
      ]);
      await fixture.verifyInert();
    });
  });
});
