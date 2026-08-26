import { expect as effectExpect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";

describe("Effect test integration", () => {
  it.effect("shares the Vite+ Vitest runtime", () =>
    Effect.sync(() => {
      expect(effectExpect).toBe(expect);
    }),
  );
});

describe("Effect test Scope", () => {
  let scopeFinalized = false;

  afterEach(() => {
    expect(scopeFinalized).toBe(true);
  });

  it.effect("closes its Scope after the Effect completes", () =>
    Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => {
        scopeFinalized = true;
      }),
    ),
  );
});

test("pins one Vite+ test toolchain with explicit peer providers", () => {
  const rootManifest = readManifest(new URL("../package.json", import.meta.url));
  const viteManifest = readManifest(import.meta.resolve("vite/package.json"));
  const vitePlusManifest = readManifest(import.meta.resolve("vite-plus/package.json"));

  expect(rootManifest.devDependencies?.["vite-plus"]).toBe(vitePlusManifest.version);
  expect(rootManifest.devDependencies?.["vite"]).toBe(
    `npm:${viteManifest.name}@${viteManifest.version}`,
  );
  expect(rootManifest.devDependencies?.["vitest"]).toBe(vitePlusManifest.dependencies?.["vitest"]);
  expect(rootManifest.devDependencies?.["@effect/vitest"]).toBeDefined();
});

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function readManifest(url: string | URL): PackageManifest {
  const path = typeof url === "string" ? fileURLToPath(url) : url;
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

test("resolves Vite+ and Effect helpers to one Vite and Vitest runtime", () => {
  const rootVite = resolvedPackagePath(import.meta.resolve("vite/package.json"));
  const vitePlusCore = resolvedDependencyPath(
    "vite-plus",
    "@voidzero-dev/vite-plus-core/package.json",
  );
  const vitePlusVite = resolvedDependencyPath("vite-plus", "vite/package.json");
  const vitestVite = resolvedDependencyPath("vitest", "vite/package.json");
  const rootVitest = resolvedPackagePath(import.meta.resolve("vitest/package.json"));
  const vitePlusVitest = resolvedDependencyPath("vite-plus", "vitest/package.json");
  const effectVitest = resolvedDependencyPath("@effect/vitest", "vitest/package.json");

  expect(new Set([rootVite, vitePlusCore, vitePlusVite, vitestVite])).toEqual(new Set([rootVite]));
  expect(new Set([rootVitest, vitePlusVitest, effectVitest])).toEqual(new Set([rootVitest]));
});

function resolvedDependencyPath(packageName: string, dependency: string): string {
  const packageManifest = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  return realpathSync(createRequire(packageManifest).resolve(dependency));
}

function resolvedPackagePath(packageUrl: string): string {
  return realpathSync(fileURLToPath(packageUrl));
}
