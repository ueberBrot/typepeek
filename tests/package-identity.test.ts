import { expect, it } from "vite-plus/test";

import { readJsonPackageIdentity } from "#typepeek/inspection/package-identity";

it("reads only own Package Identity data properties", () => {
  let inheritedVersionReads = 0;
  const inherited = Object.create(null, {
    version: {
      get() {
        inheritedVersionReads += 1;
        return undefined;
      },
    },
  });
  const identity = Object.create(inherited, {
    name: { enumerable: true, value: "example" },
  });

  expect(readJsonPackageIdentity(identity)).toEqual({ name: "example" });
  expect(inheritedVersionReads).toBe(0);
  expect(readJsonPackageIdentity({ name: "example", version: undefined })).toBeUndefined();
});

it("constructs Package Identity without assigning through Object.prototype", () => {
  let inheritedVersionReads = 0;
  Object.defineProperty(Object.prototype, "version", {
    configurable: true,
    get() {
      inheritedVersionReads += 1;
      return undefined;
    },
  });

  try {
    expect(readJsonPackageIdentity({ name: "example" })).toEqual({ name: "example" });
    expect(readJsonPackageIdentity({ name: "example", version: "1.0.0" })).toEqual({
      name: "example",
      version: "1.0.0",
    });
    expect(readJsonPackageIdentity({ name: "example", version: undefined })).toBeUndefined();
    expect(inheritedVersionReads).toBe(0);
  } finally {
    Reflect.deleteProperty(Object.prototype, "version");
  }
});
