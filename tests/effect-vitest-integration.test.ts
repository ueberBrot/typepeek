import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { expect as effectExpect, effect as scopedIt } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";

const packageManifestSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String)
  ),
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});

const readManifest = function readManifest(url: string | URL): PackageManifest {
  const path = Predicate.isString(url) ? fileURLToPath(url) : url;

  return decodeJson(packageManifestSchema, readFileSync(path, "utf-8"));
};

type PackageManifest = typeof packageManifestSchema.Type;

const resolvedPackagePath = function resolvedPackagePath(
  packageUrl: string
): string {
  return realpathSync(fileURLToPath(packageUrl));
};

const resolvedDependencyPath = function resolvedDependencyPath(
  packageName: string,
  dependency: string
): string {
  const packageManifest = fileURLToPath(
    import.meta.resolve(`${packageName}/package.json`)
  );

  return realpathSync(createRequire(packageManifest).resolve(dependency));
};

const verifyEffectScenario = () => {
  expect(effectExpect).toBe(expect);
};

describe("effect-vitest-integration", () => {
  describe("Effect test integration", () => {
    scopedIt("shares the Vite+ Vitest runtime", () =>
      Effect.sync(verifyEffectScenario)
    );
  });
  describe("Effect test Scope", () => {
    let scopeFinalized = false;

    const assertScopeOpen = () => {
      expect(scopeFinalized).toBeFalsy();
    };

    afterEach(() => {
      // oxlint-disable-next-line vitest/no-standalone-expect -- The Effect test adapter releases its Scope after the test body; this hook observes that finalization.
      expect(scopeFinalized).toBeTruthy();
    });
    scopedIt("closes its Scope after the Effect completes", () => {
      assertScopeOpen();

      return Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          scopeFinalized = true;
        })
      );
    });
  });

  it("pins one Vite+ test toolchain with explicit peer providers", () => {
    const rootManifest = readManifest(
      new URL("../package.json", import.meta.url)
    );

    const viteManifest = readManifest(import.meta.resolve("vite/package.json"));

    const vitePlusManifest = readManifest(
      import.meta.resolve("vite-plus/package.json")
    );

    expect([
      rootManifest.devDependencies?.["vite-plus"],
      rootManifest.devDependencies?.["vite"],
      rootManifest.devDependencies?.["vitest"],
      rootManifest.devDependencies?.["@effect/vitest"] !== undefined,
    ]).toStrictEqual([
      vitePlusManifest.version,
      `npm:${viteManifest.name}@${viteManifest.version}`,
      vitePlusManifest.dependencies?.["vitest"],
      true,
    ]);
  });

  it("resolves Vite+ and Effect helpers to one Vite and Vitest runtime", () => {
    const rootVite = resolvedPackagePath(
      import.meta.resolve("vite/package.json")
    );

    const vitePlusVite = resolvedDependencyPath(
      "vite-plus",
      "vite/package.json"
    );

    const vitestVite = resolvedDependencyPath("vitest", "vite/package.json");

    const rootVitest = resolvedPackagePath(
      import.meta.resolve("vitest/package.json")
    );

    const vitePlusVitest = resolvedDependencyPath(
      "vite-plus",
      "vitest/package.json"
    );

    const effectVitest = resolvedDependencyPath(
      "@effect/vitest",
      "vitest/package.json"
    );

    expect([
      new Set([rootVite, vitePlusVite, vitestVite]),
      new Set([rootVitest, vitePlusVitest, effectVitest]),
    ]).toStrictEqual([new Set([rootVite]), new Set([rootVitest])]);
  });
});
