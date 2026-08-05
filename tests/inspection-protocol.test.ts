import { expect, it } from "vite-plus/test";

import {
  enforceInspectionOutcome,
  readInterfaceOverviewRequest,
} from "#typepeek/inspection/protocol";

it("normalizes the default Access Style at the worker protocol seam", () => {
  expect(
    readInterfaceOverviewRequest({
      resolutionContext: "/repository",
      specifier: "example",
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "import",
    },
  });
});

it("rejects an invalid Access Style at the worker protocol seam", () => {
  expect(
    readInterfaceOverviewRequest({
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "script",
    }),
  ).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid Interface Overview request.",
    },
  });
});

it("rejects a structurally incomplete successful Inspection Outcome", () => {
  expect(
    enforceInspectionOutcome({
      status: "success",
      result: {},
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});
