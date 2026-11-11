import { describe, expect, it } from "vite-plus/test";

import { readJsonPackageIdentity } from "#typepeek/inspection/evidence/package-identity";

import { defineObjectPrototypeProperty } from "./helpers/prototype-fixture.ts";

describe("package-identity", () => {
  it("reads only own Package Identity data properties", () => {
    let inheritedVersionReads = 0;

    const inherited = {};
    Object.setPrototypeOf(inherited, null);
    Object.defineProperties(inherited, {
      version: {
        get() {
          inheritedVersionReads += 1;
        },
      },
    });

    const identity = {};
    Object.setPrototypeOf(identity, inherited);
    Object.defineProperties(identity, {
      name: { enumerable: true, value: "example" },
    });

    expect([
      readJsonPackageIdentity(identity),
      inheritedVersionReads,
      readJsonPackageIdentity({
        name: "example",
        ...Object.fromEntries([["version", undefined]]),
      }) === undefined,
    ]).toStrictEqual([{ name: "example" }, 0, true]);
  });

  it("constructs Package Identity without assigning through Object.prototype", () => {
    let inheritedVersionReads = 0;
    defineObjectPrototypeProperty("version", {
      configurable: true,
      get() {
        inheritedVersionReads += 1;
      },
    });

    try {
      expect([
        readJsonPackageIdentity({ name: "example" }),
        readJsonPackageIdentity({ name: "example", version: "1.0.0" }),
        readJsonPackageIdentity({
          name: "example",
          ...Object.fromEntries([["version", undefined]]),
        }) === undefined,
        inheritedVersionReads,
      ]).toStrictEqual([
        {
          name: "example",
        },
        {
          name: "example",
          version: "1.0.0",
        },
        true,
        0,
      ]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "version");
    }
  });
});
