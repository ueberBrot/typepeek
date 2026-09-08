import { expect, it } from "vite-plus/test";

import { readInspectionPlanQueries } from "#typepeek/inspection/inspection-plan-query";
import {
  readAnalysisRequest,
  readInspectionRequest,
} from "#typepeek/inspection/request-definitions";

it("normalizes the default Access Style through its executable definition", () => {
  expect(
    readInspectionRequest("interface-overview", {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: undefined,
      ignoredTransportField: true,
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

it("normalizes lightweight discovery requests", () => {
  const target = { resolutionContext: "/repository", specifier: "example" };
  expect(readInspectionRequest("export-search", { ...target, query: "error" })).toEqual({
    accepted: true,
    request: { ...target, query: "error", accessStyle: "import" },
  });
  expect(readInspectionRequest("public-subpath-discovery", target)).toEqual({
    accepted: true,
    request: { ...target, accessStyle: "import" },
  });
  expect(readInspectionRequest("export-search", { ...target, query: "" })).toMatchObject({
    accepted: false,
  });
});

it("normalizes declaration and bounded Member requests", () => {
  const target = { resolutionContext: "/repository", specifier: "example" };
  expect(
    readInspectionRequest("declaration-inspection", {
      ...target,
      exportName: "createExample",
    }),
  ).toMatchObject({
    accepted: true,
    request: { ...target, accessStyle: "import", exportName: "createExample" },
  });
  expect(
    readInspectionRequest("member-inspection", {
      ...target,
      exportName: "Example",
      memberPath: ["nested", "value"],
    }),
  ).toMatchObject({
    accepted: true,
    request: {
      ...target,
      accessStyle: "import",
      exportName: "Example",
      memberPath: ["nested", "value"],
    },
  });
});

it("normalizes every bounded Inspection Plan query through one definition", () => {
  const queries = [
    { intent: "interface-overview" },
    { intent: "signature-inspection", exportName: "createExample" },
    { intent: "export-search", query: "example" },
    { intent: "public-subpath-discovery" },
    { intent: "declaration-inspection", exportName: "createExample" },
    { intent: "member-inspection", exportName: "Example", memberPath: ["value"] },
  ] as const;

  expect(
    readInspectionRequest("inspection-plan", {
      resolutionContext: "/repository",
      specifier: "example",
      queries,
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "import",
      queries,
    },
  });
});

it("rejects empty and oversized Inspection Plans", () => {
  const target = { resolutionContext: "/repository", specifier: "example" };
  expect(readInspectionRequest("inspection-plan", { ...target, queries: [] })).toMatchObject({
    accepted: false,
  });
  expect(
    readInspectionRequest("inspection-plan", {
      ...target,
      queries: Array.from({ length: 17 }, () => ({ intent: "interface-overview" })),
    }),
  ).toMatchObject({ accepted: false });
});

it("rejects empty and accessor-backed Member paths", () => {
  const target = { resolutionContext: "/repository", specifier: "example" };
  expect(
    readInspectionRequest("member-inspection", {
      ...target,
      exportName: "Example",
      memberPath: [],
    }),
  ).toMatchObject({ accepted: false });

  let pathAccessorRead = false;
  const memberPath = Array.from({ length: 1 }) as string[];
  Object.defineProperty(memberPath, "0", {
    enumerable: true,
    get() {
      pathAccessorRead = true;
      return "value";
    },
  });
  expect(
    readInspectionRequest("member-inspection", {
      ...target,
      exportName: "Example",
      memberPath,
    }),
  ).toMatchObject({ accepted: false });
  expect(pathAccessorRead).toBe(false);
});

it("rejects Inspection Plan query accessors without evaluating them", () => {
  const target = { resolutionContext: "/repository", specifier: "example" };
  let queryAccessorRead = false;
  const queries = [{ intent: "interface-overview" }];
  Object.defineProperty(queries, "0", {
    enumerable: true,
    get() {
      queryAccessorRead = true;
      return { intent: "interface-overview" };
    },
  });
  expect(readInspectionRequest("inspection-plan", { ...target, queries })).toMatchObject({
    accepted: false,
  });
  expect(queryAccessorRead).toBe(false);

  let intentAccessorRead = false;
  const query = {
    get intent(): string {
      intentAccessorRead = true;
      return "interface-overview";
    },
  };
  expect(readInspectionRequest("inspection-plan", { ...target, queries: [query] })).toMatchObject({
    accepted: false,
  });
  expect(intentAccessorRead).toBe(false);
});

it("rejects an invalid Access Style", () => {
  const invalidOverview = {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Interface Overview request.",
  } as const;
  expect(
    readInspectionRequest("interface-overview", {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "script",
    }),
  ).toEqual({ accepted: false, outcome: invalidOverview });
});

it("rejects array-shaped request records", () => {
  const invalidOverview = {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid Interface Overview request.",
  } as const;
  expect(
    readInspectionRequest(
      "interface-overview",
      Object.assign([], { resolutionContext: "/repository", specifier: "example" }),
    ),
  ).toEqual({ accepted: false, outcome: invalidOverview });
});

it("normalizes an Export Inspection request", () => {
  expect(
    readInspectionRequest("export-inspection", {
      resolutionContext: "/repository",
      specifier: "example",
      exportName: "createExample",
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      exportName: "createExample",
      accessStyle: "import",
    },
  });
});

it("discriminates the Export Inspection analysis envelope", () => {
  expect(
    readAnalysisRequest({
      intent: "export-inspection",
      request: {
        resolutionContext: "/repository",
        specifier: "example",
        exportName: "createExample",
        accessStyle: "require",
      },
    }),
  ).toEqual({
    accepted: true,
    request: {
      intent: "export-inspection",
      request: {
        resolutionContext: "/repository",
        specifier: "example",
        exportName: "createExample",
        accessStyle: "require",
      },
    },
  });
});

it("normalizes and discriminates a Signature Inspection request", () => {
  const signature = {
    resolutionContext: "/repository",
    specifier: "example",
    exportName: "createExample",
  };
  expect(readInspectionRequest("signature-inspection", signature)).toEqual({
    accepted: true,
    request: { ...signature, accessStyle: "import" },
  });
  expect(
    readAnalysisRequest({
      intent: "signature-inspection",
      request: { ...signature, accessStyle: "require" },
    }),
  ).toEqual({
    accepted: true,
    request: {
      intent: "signature-inspection",
      request: { ...signature, accessStyle: "require" },
    },
  });
});

it("rejects array-shaped analysis envelopes", () => {
  const invalidAnalysis = {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid request.",
  } as const;
  const arrayEnvelope = Object.assign([], {
    intent: "interface-overview",
    request: { resolutionContext: "/repository", specifier: "example" },
  });
  expect(readAnalysisRequest(arrayEnvelope)).toEqual({
    accepted: false,
    outcome: invalidAnalysis,
  });
});

it("contains hostile request and envelope accessors without evaluating them", () => {
  const invalidAnalysis = {
    status: "unsupported",
    reason: "invalid-request",
    message: "Inspection received an invalid request.",
  } as const;
  let requestGetterRead = false;
  const request: unknown[] = [];
  Object.defineProperty(request, "resolutionContext", {
    get() {
      requestGetterRead = true;
      throw new Error("request getter was evaluated");
    },
  });
  expect(readInspectionRequest("interface-overview", request)).toMatchObject({ accepted: false });
  expect(requestGetterRead).toBe(false);

  let envelopeGetterRead = false;
  const envelope: unknown[] = [];
  Object.defineProperty(envelope, "intent", {
    get() {
      envelopeGetterRead = true;
      throw new Error("envelope getter was evaluated");
    },
  });
  expect(readAnalysisRequest(envelope)).toEqual({ accepted: false, outcome: invalidAnalysis });
  expect(envelopeGetterRead).toBe(false);
});

it("rejects request fields that change during boundary reading", () => {
  let specifierReads = 0;
  const changingRequest = {
    resolutionContext: "/repository",
    get specifier() {
      specifierReads += 1;
      return specifierReads === 1 ? "example" : 42;
    },
  };
  expect(readInspectionRequest("interface-overview", changingRequest)).toMatchObject({
    accepted: false,
  });
  expect(specifierReads).toBe(0);
});

it("normalizes Member Discovery with qualified selectors and an optional root path", () => {
  const target = { resolutionContext: "/repository", specifier: "example", exportName: "Example" };
  expect(readInspectionRequest("member-discovery", target)).toEqual({
    accepted: true,
    request: { ...target, accessStyle: "import", memberPath: [] },
  });
  const query = {
    intent: "member-discovery",
    exportName: "Example",
    memberPath: [{ name: "nested", space: "namespace" }],
    query: "VaL",
  };
  expect(readInspectionRequest("inspection-plan", { ...target, queries: [query] })).toMatchObject({
    accepted: true,
    request: { queries: [query] },
  });
});

it("rejects malformed and behavioral Member selectors in direct requests and plans", () => {
  const target = { resolutionContext: "/repository", specifier: "example", exportName: "Example" };
  let accessorCalls = 0;
  const accessor = {
    name: "nested",
    get space() {
      accessorCalls += 1;
      return "type";
    },
  };
  const inherited = Object.create({ name: "nested", space: "type" });
  const invalidPaths = [
    null,
    [""],
    [{ name: "nested", space: "static" }],
    [{ name: "nested", space: "type", extra: true }],
    [accessor],
    [inherited],
    Array(1),
    ["x".repeat(257)],
    Array(17).fill("x"),
  ];
  for (const memberPath of invalidPaths) {
    for (const intent of ["member-discovery", "member-inspection"] as const) {
      expect(readInspectionRequest(intent, { ...target, memberPath })).toMatchObject({
        accepted: false,
      });
      expect(
        readInspectionRequest("inspection-plan", {
          ...target,
          queries: [{ intent, exportName: "Example", memberPath }],
        }),
      ).toMatchObject({ accepted: false });
    }
  }
  expect(accessorCalls).toBe(0);
});

it("bounds Member Discovery queries and snapshots qualified selectors", () => {
  const target = { resolutionContext: "/repository", specifier: "example", exportName: "Example" };
  for (const query of ["", "é".repeat(129), null, 4, undefined]) {
    expect(readInspectionRequest("member-discovery", { ...target, query })).toMatchObject({
      accepted: false,
    });
  }
  const segment = { name: "nested", space: "type" };
  const reading = readInspectionRequest("member-discovery", {
    ...target,
    memberPath: [segment],
    query: "é".repeat(128),
  });
  segment.name = "changed";
  expect(reading).toMatchObject({
    accepted: true,
    request: { memberPath: [{ name: "nested", space: "type" }] },
  });
  let accessorCalls = 0;
  expect(
    readInspectionRequest("member-discovery", {
      ...target,
      get query() {
        accessorCalls += 1;
        return "name";
      },
    }),
  ).toMatchObject({ accepted: false });
  expect(accessorCalls).toBe(0);
});

it("identifies invalid Member Discovery plan queries without evaluating supplied behavior", () => {
  let accessorCalls = 0;
  const invalidQueries = [
    { intent: "member-discovery", exportName: "Example", query: "" },
    { intent: "member-discovery", exportName: "Example", memberPath: [""] },
    {
      intent: "member-discovery",
      exportName: "Example",
      get query() {
        accessorCalls += 1;
        return "name";
      },
    },
    {
      intent: "member-discovery",
      exportName: "Example",
      memberPath: [
        {
          name: "nested",
          get space() {
            accessorCalls += 1;
            return "type";
          },
        },
      ],
    },
  ];
  for (const query of invalidQueries) {
    expect(readInspectionPlanQueries([query])).toEqual({
      accepted: false,
      issue: "invalid-member-discovery",
    });
  }
  expect(accessorCalls).toBe(0);
});
