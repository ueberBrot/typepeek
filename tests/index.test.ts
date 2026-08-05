import { describe, expect, it } from "vite-plus/test";

import { TYPEPEEK_PACKAGE_NAME } from "#typepeek/index";

describe("library entrypoint", () => {
  it("can be imported by a caller", () => {
    expect(TYPEPEEK_PACKAGE_NAME).toBe("typepeek");
  });
});
