import { describe, expect, it } from "vite-plus/test";

import { enforceInspectionOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";

import { registerDataAdmissionTests } from "./inspection-outcome-authority/data-admission.test.suite.ts";
import { registerNamespaceGraphTests } from "./inspection-outcome-authority/namespace-graph.test.suite.ts";
import { registerRequestCorrelationTests } from "./inspection-outcome-authority/request-correlation.test.suite.ts";
import { registerResultContractTests } from "./inspection-outcome-authority/result-contract.test.suite.ts";

describe("inspection-outcome-authority", () => {
  it("rejects a structurally incomplete successful Inspection Outcome", () => {
    expect(
      enforceInspectionOutcome("interface-overview", {
        result: {},
        status: "success",
      })
    ).toStrictEqual({
      message: "Inspection returned an invalid result.",
      reason: "invalid-result",
      status: "unsupported",
    });
  });

  registerResultContractTests();
  registerRequestCorrelationTests();
  registerDataAdmissionTests();
  registerNamespaceGraphTests();
});
