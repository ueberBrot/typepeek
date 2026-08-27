import { expect, it } from "vite-plus/test";

import { compareInterfaceOverviews } from "#typepeek/inspection/public-interface-comparison";

it("applies one aggregate result-construction budget to a comparison delta", () => {
  const overview = (prefix: string) => ({
    intent: "interface-overview" as const,
    specifier: "example",
    resolutionVariant: { accessStyle: "import" as const },
    packageIdentity: { name: "example" },
    publicSubpaths: [],
    moduleExports: Array.from({ length: 200 }, (_, index) => ({
      name: `${prefix}-${String(index).padStart(3, "0")}-${"x".repeat(150)}`,
    })),
  });

  expect(compareInterfaceOverviews(overview("before"), overview("after"))).toEqual({
    status: "limit-exceeded",
    reason: "budget-exceeded",
    exceededBudget: "result-construction",
    message: "Inspection exceeded its output limit.",
  });
});
