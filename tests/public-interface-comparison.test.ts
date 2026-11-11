import { describe, expect, it } from "vite-plus/test";

import { compareInterfaceOverviews } from "#typepeek/inspection/queries/public-interface-comparison";

const overview = (prefix: string) => ({
  intent: "interface-overview" as const,
  moduleExports: Array.from({ length: 200 }, (_, index) => ({
    name: `${prefix}-${String(index).padStart(3, "0")}-${"x".repeat(150)}`,
  })),
  packageIdentity: { name: "example" },
  publicSubpaths: [],
  resolutionVariant: { accessStyle: "import" as const },
  specifier: "example",
});

describe("public-interface-comparison", () => {
  it("applies one aggregate result-construction budget to a comparison delta", () => {
    expect(
      compareInterfaceOverviews(overview("before"), overview("after"))
    ).toStrictEqual({
      exceededBudget: "result-construction",
      message: "Inspection exceeded its output limit.",
      reason: "budget-exceeded",
      status: "limit-exceeded",
    });
  });
});
