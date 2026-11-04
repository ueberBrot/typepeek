import { describe, expect, it } from "vite-plus/test";

import { readInspectionPlanQueries } from "#typepeek/inspection/inspection-plan-query";
import {
  readAnalysisRequest,
  readInspectionRequest,
} from "#typepeek/inspection/request-definitions";

import { match } from "./helpers/matchers.ts";

describe("request-definitions", () => {
  it("normalizes the default Access Style through its executable definition", () => {
    expect(
      readInspectionRequest("interface-overview", {
        ...Object.fromEntries([["accessStyle", undefined]]),
        ignoredTransportField: true,
        resolutionContext: "/repository",
        specifier: "example",
      })
    ).toStrictEqual({
      accepted: true,
      request: {
        accessStyle: "import",
        resolutionContext: "/repository",
        specifier: "example",
      },
    });
  });

  it("normalizes lightweight discovery requests", () => {
    const target = { resolutionContext: "/repository", specifier: "example" };
    expect([
      readInspectionRequest("export-search", { ...target, query: "error" }),
      readInspectionRequest("public-subpath-discovery", target),
      readInspectionRequest("export-search", { ...target, query: "" }),
    ]).toStrictEqual([
      {
        accepted: true,
        request: { ...target, accessStyle: "import", query: "error" },
      },
      {
        accepted: true,
        request: { ...target, accessStyle: "import" },
      },
      match.objectContaining({
        accepted: false,
      }),
    ]);
  });

  it("normalizes declaration and bounded Member requests", () => {
    const target = { resolutionContext: "/repository", specifier: "example" };
    expect([
      readInspectionRequest("declaration-inspection", {
        ...target,
        exportName: "createExample",
      }),
      readInspectionRequest("member-inspection", {
        ...target,
        exportName: "Example",
        memberPath: ["nested", "value"],
      }),
    ]).toStrictEqual([
      match.objectContaining({
        accepted: true,
        request: match.objectContaining({
          ...target,
          accessStyle: "import",
          exportName: "createExample",
        }),
      }),
      match.objectContaining({
        accepted: true,
        request: match.objectContaining({
          ...target,
          accessStyle: "import",
          exportName: "Example",
          memberPath: ["nested", "value"],
        }),
      }),
    ]);
  });

  it("normalizes every bounded Inspection Plan query through one definition", () => {
    const queries = [
      { intent: "interface-overview" },
      { exportName: "createExample", intent: "signature-inspection" },
      { intent: "export-search", query: "example" },
      { intent: "public-subpath-discovery" },
      { exportName: "createExample", intent: "declaration-inspection" },
      {
        exportName: "Example",
        intent: "member-inspection",
        memberPath: ["value"],
      },
    ] as const;

    expect(
      readInspectionRequest("inspection-plan", {
        queries,
        resolutionContext: "/repository",
        specifier: "example",
      })
    ).toStrictEqual({
      accepted: true,
      request: {
        accessStyle: "import",
        queries,
        resolutionContext: "/repository",
        specifier: "example",
      },
    });
  });

  it("rejects empty and oversized Inspection Plans", () => {
    const target = { resolutionContext: "/repository", specifier: "example" };
    expect([
      readInspectionRequest("inspection-plan", { ...target, queries: [] }),
      readInspectionRequest("inspection-plan", {
        ...target,
        queries: Array.from({ length: 17 }, () => ({
          intent: "interface-overview",
        })),
      }),
    ]).toStrictEqual([
      match.objectContaining({
        accepted: false,
      }),
      match.objectContaining({ accepted: false }),
    ]);
  });

  it("rejects empty and accessor-backed Member paths", () => {
    const target = { resolutionContext: "/repository", specifier: "example" };
    expect(
      readInspectionRequest("member-inspection", {
        ...target,
        exportName: "Example",
        memberPath: [],
      })
    ).toMatchObject({ accepted: false });
    let pathAccessorRead = false;
    const memberPath = Array.from({ length: 1 });
    Object.defineProperty(memberPath, "0", {
      enumerable: true,
      get() {
        pathAccessorRead = true;

        return "value";
      },
    });
    expect([
      readInspectionRequest("member-inspection", {
        ...target,
        exportName: "Example",
        memberPath,
      }),
      pathAccessorRead,
    ]).toStrictEqual([match.objectContaining({ accepted: false }), false]);
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
    expect([
      readInspectionRequest("inspection-plan", { ...target, queries }),
      queryAccessorRead,
    ]).toStrictEqual([
      match.objectContaining({
        accepted: false,
      }),
      false,
    ]);
    let intentAccessorRead = false;

    const query = {
      get intent(): string {
        intentAccessorRead = true;

        return "interface-overview";
      },
    };

    expect([
      readInspectionRequest("inspection-plan", { ...target, queries: [query] }),
      intentAccessorRead,
    ]).toStrictEqual([
      match.objectContaining({
        accepted: false,
      }),
      false,
    ]);
  });

  it("rejects an invalid Access Style", () => {
    const invalidOverview = {
      message: "Inspection received an invalid Interface Overview request.",
      reason: "invalid-request",
      status: "unsupported",
    } as const;

    expect(
      readInspectionRequest("interface-overview", {
        accessStyle: "script",
        resolutionContext: "/repository",
        specifier: "example",
      })
    ).toStrictEqual({ accepted: false, outcome: invalidOverview });
  });

  it("rejects array-shaped request records", () => {
    const invalidOverview = {
      message: "Inspection received an invalid Interface Overview request.",
      reason: "invalid-request",
      status: "unsupported",
    } as const;

    expect(
      readInspectionRequest(
        "interface-overview",
        Object.assign([], {
          resolutionContext: "/repository",
          specifier: "example",
        })
      )
    ).toStrictEqual({ accepted: false, outcome: invalidOverview });
  });

  it("normalizes an Export Inspection request", () => {
    expect(
      readInspectionRequest("export-inspection", {
        exportName: "createExample",
        resolutionContext: "/repository",
        specifier: "example",
      })
    ).toStrictEqual({
      accepted: true,
      request: {
        accessStyle: "import",
        exportName: "createExample",
        resolutionContext: "/repository",
        specifier: "example",
      },
    });
  });

  it("discriminates the Export Inspection analysis envelope", () => {
    expect(
      readAnalysisRequest({
        intent: "export-inspection",
        request: {
          accessStyle: "require",
          exportName: "createExample",
          resolutionContext: "/repository",
          specifier: "example",
        },
      })
    ).toStrictEqual({
      accepted: true,
      request: {
        intent: "export-inspection",
        request: {
          accessStyle: "require",
          exportName: "createExample",
          resolutionContext: "/repository",
          specifier: "example",
        },
      },
    });
  });

  it("normalizes and discriminates a Signature Inspection request", () => {
    const signature = {
      exportName: "createExample",
      resolutionContext: "/repository",
      specifier: "example",
    };

    expect([
      readInspectionRequest("signature-inspection", signature),
      readAnalysisRequest({
        intent: "signature-inspection",
        request: { ...signature, accessStyle: "require" },
      }),
    ]).toStrictEqual([
      {
        accepted: true,
        request: { ...signature, accessStyle: "import" },
      },
      {
        accepted: true,
        request: {
          intent: "signature-inspection",
          request: { ...signature, accessStyle: "require" },
        },
      },
    ]);
  });

  it("rejects array-shaped analysis envelopes", () => {
    const invalidAnalysis = {
      message: "Inspection received an invalid request.",
      reason: "invalid-request",
      status: "unsupported",
    } as const;

    const arrayEnvelope = Object.assign([], {
      intent: "interface-overview",
      request: { resolutionContext: "/repository", specifier: "example" },
    });

    expect(readAnalysisRequest(arrayEnvelope)).toStrictEqual({
      accepted: false,
      outcome: invalidAnalysis,
    });
  });

  it("contains hostile request and envelope accessors without evaluating them", () => {
    const invalidAnalysis = {
      message: "Inspection received an invalid request.",
      reason: "invalid-request",
      status: "unsupported",
    } as const;

    let requestGetterRead = false;
    const request: unknown[] = [];
    Object.defineProperty(request, "resolutionContext", {
      get() {
        requestGetterRead = true;
        throw new Error("request getter was evaluated");
      },
    });
    expect([
      readInspectionRequest("interface-overview", request),
      requestGetterRead,
    ]).toStrictEqual([
      match.objectContaining({
        accepted: false,
      }),
      false,
    ]);
    let envelopeGetterRead = false;
    const envelope: unknown[] = [];
    Object.defineProperty(envelope, "intent", {
      get() {
        envelopeGetterRead = true;
        throw new Error("envelope getter was evaluated");
      },
    });
    expect([readAnalysisRequest(envelope), envelopeGetterRead]).toStrictEqual([
      {
        accepted: false,
        outcome: invalidAnalysis,
      },
      false,
    ]);
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

    expect([
      readInspectionRequest("interface-overview", changingRequest),
      specifierReads,
    ]).toStrictEqual([
      match.objectContaining({
        accepted: false,
      }),
      0,
    ]);
  });

  it("normalizes Member Discovery with qualified selectors and an optional root path", () => {
    const target = {
      exportName: "Example",
      resolutionContext: "/repository",
      specifier: "example",
    };

    expect(readInspectionRequest("member-discovery", target)).toStrictEqual({
      accepted: true,
      request: { ...target, accessStyle: "import", memberPath: [] },
    });

    const query = {
      exportName: "Example",
      intent: "member-discovery",
      memberPath: [{ name: "nested", space: "namespace" }],
      query: "VaL",
    };

    expect(
      readInspectionRequest("inspection-plan", { ...target, queries: [query] })
    ).toMatchObject({
      accepted: true,
      request: { queries: [query] },
    });
  });

  it("rejects malformed and behavioral Member selectors in direct requests and plans", () => {
    const target = {
      exportName: "Example",
      resolutionContext: "/repository",
      specifier: "example",
    };

    let accessorCalls = 0;

    const accessor = {
      name: "nested",
      get space() {
        accessorCalls += 1;

        return "type";
      },
    };

    const inherited = {};
    Object.setPrototypeOf(inherited, { name: "nested", space: "type" });

    const sparsePath: string[] = [];
    sparsePath.length = 1;

    const invalidPaths = [
      null,
      [""],
      [{ name: "nested", space: "static" }],
      [{ extra: true, name: "nested", space: "type" }],
      [accessor],
      [inherited],
      sparsePath,
      ["x".repeat(257)],
      Array.from({ length: 17 }, () => "x"),
    ];

    for (const memberPath of invalidPaths) {
      for (const intent of ["member-discovery", "member-inspection"] as const) {
        expect([
          readInspectionRequest(intent, { ...target, memberPath }),
          readInspectionRequest("inspection-plan", {
            ...target,
            queries: [{ exportName: "Example", intent, memberPath }],
          }),
        ]).toStrictEqual([
          match.objectContaining({
            accepted: false,
          }),
          match.objectContaining({ accepted: false }),
        ]);
      }
    }

    expect(accessorCalls).toBe(0);
  });

  it("bounds Member Discovery queries and snapshots qualified selectors", () => {
    const target = {
      exportName: "Example",
      resolutionContext: "/repository",
      specifier: "example",
    };

    for (const query of ["", "é".repeat(129), null, 4, undefined]) {
      expect(
        readInspectionRequest("member-discovery", { ...target, query })
      ).toMatchObject({
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
    expect([
      readInspectionRequest("member-discovery", {
        ...target,
        get query() {
          accessorCalls += 1;

          return "name";
        },
      }),
      accessorCalls,
    ]).toStrictEqual([match.objectContaining({ accepted: false }), 0]);
  });

  it("identifies invalid Member Discovery plan queries without evaluating supplied behavior", () => {
    let accessorCalls = 0;

    const invalidQueries = [
      { exportName: "Example", intent: "member-discovery", query: "" },
      { exportName: "Example", intent: "member-discovery", memberPath: [""] },
      {
        exportName: "Example",
        intent: "member-discovery",
        get query() {
          accessorCalls += 1;

          return "name";
        },
      },
      {
        exportName: "Example",
        intent: "member-discovery",
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
      expect(readInspectionPlanQueries([query])).toStrictEqual({
        accepted: false,
        issue: "invalid-member-discovery",
      });
    }

    expect(accessorCalls).toBe(0);
  });
});
