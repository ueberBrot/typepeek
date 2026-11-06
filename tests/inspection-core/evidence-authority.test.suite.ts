import { expect, test } from "vite-plus/test";

import {
  inspectInterfaceOverview,
  inspectPublicSubpaths,
} from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";

export const registerEvidenceAuthorityTests =
  function registerEvidenceAuthorityTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("rejects malformed Package Identity evidence explicitly", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/malformed-manifest",
      });

      expect(outcome).toMatchObject({
        message: "The installed package has no valid Package Identity.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    test("rejects a non-string declared Package Identity version", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/invalid-version",
      });

      expect(outcome).toMatchObject({
        message: "The installed package has no valid Package Identity.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    test("preserves a scoped alias Specifier and its unversioned Package Identity", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/aliased-unversioned",
      });

      expect(outcome).toMatchObject({
        result: {
          moduleExports: [{ name: "aliasedExport" }],
          packageIdentity: {
            name: "@upstream/unversioned",
          },
          specifier: "@typepeek-fixture/aliased-unversioned",
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        throw new Error("Expected a successful inspection result.");
      }

      expect(outcome.result.packageIdentity).not.toHaveProperty("version");
    });

    test("rejects path-like Specifiers before package resolution", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "..",
      });

      expect(outcome).toMatchObject({
        message:
          "The requested Specifier is outside the static Inspectable Module boundary.",
        reason: "static-boundary",
        status: "static-boundary",
      });
    });

    test("does not follow declarations into caller project source", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/escaping",
      });

      expect(outcome).toMatchObject({
        message:
          "A declaration references source outside its installed package boundary.",
        reason: "static-boundary",
        status: "static-boundary",
      });
    });

    test("does not probe outside paths from unresolved declaration imports", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/outside-resolution-storm",
      });

      expect(outcome).toMatchObject({
        message:
          "A declaration references source outside its installed package boundary.",
        reason: "static-boundary",
        status: "static-boundary",
      });
    });

    test("shares wildcard directory discovery across public subpath patterns", async () => {
      const outcome = await inspectPublicSubpaths({
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/shared-pattern-files",
      });

      expect(outcome).toMatchObject({
        result: {
          publicSubpaths: Array.from({ length: 8 }, (_, index) => ({
            specifier: `@typepeek-fixture/shared-pattern-files/group-${index}/red`,
          })),
        },
        status: "success",
      });
    });
  };
