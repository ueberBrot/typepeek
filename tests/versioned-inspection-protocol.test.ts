import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import {
  INSPECTION_PROTOCOL_VERSION,
  INSPECTION_INTENTS,
  inspectCapabilities,
  inspectExport,
  invokeInspectionProtocol,
} from "#typepeek/inspection";

import { type CompiledPackageFixture, materializeCompiledPackageFixture } from "./helpers/index.ts";

let fixture: CompiledPackageFixture;

beforeAll(async () => {
  fixture = await materializeCompiledPackageFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
});

it("publishes deterministic adapter capabilities without TypeScript enums", () => {
  expect(inspectCapabilities()).toEqual({
    intent: "capabilities",
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    supportedProtocolVersions: [INSPECTION_PROTOCOL_VERSION],
    supportedIntents: [
      "interface-overview",
      "export-inspection",
      "signature-inspection",
      "export-search",
      "public-subpath-discovery",
      "declaration-inspection",
      "member-inspection",
      "inspection-plan",
    ],
    failureReasons: [
      "specifier-not-found",
      "export-not-found",
      "member-not-found",
      "invalid-request",
      "invalid-result",
      "unsupported-protocol-version",
      "ambiguous-member",
      "no-static-representation",
      "unsupported-evidence",
      "analysis-terminated",
      "static-boundary",
      "budget-exceeded",
    ],
    budgetDimensions: expect.arrayContaining([
      "request-bytes",
      "analysis-deadline",
      "analysis-memory",
      "analysis-output-bytes",
      "result-construction",
      "module-exports",
      "merged-declarations",
    ]),
  });
});

it("returns machine-readable reasons and exceeded budget dimensions", async () => {
  await expect(
    inspectExport({
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
      exportName: "missing",
    }),
  ).resolves.toEqual({
    status: "not-found",
    reason: "export-not-found",
    message: 'Module Export "missing" was not found in "@typepeek-fixture/focused".',
  });

  await expect(
    invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "interface-overview",
      request: {
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/broad",
      },
    }),
  ).resolves.toEqual({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    outcome: {
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget: "module-exports",
      message: "Inspection exceeded its Module Export limit.",
    },
  });
});

it("rejects unsupported protocol versions before inspection", async () => {
  await expect(
    invokeInspectionProtocol({
      protocolVersion: "999",
      intent: "interface-overview",
      request: {
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/focused",
      },
    }),
  ).resolves.toEqual({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    outcome: {
      status: "unsupported",
      reason: "unsupported-protocol-version",
      message: 'Inspection protocol version "999" is not supported.',
    },
  });
});

it.each([
  null,
  {},
  {
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "runtime-execution",
    request: {},
  },
  {
    protocolVersion: "x".repeat(65),
    intent: "interface-overview",
    request: {},
  },
])("rejects malformed adapter envelopes without entering inspection", async (request) => {
  await expect(invokeInspectionProtocol(request)).resolves.toEqual({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    outcome: {
      status: "unsupported",
      reason: "invalid-request",
      message: "Inspection received an invalid versioned protocol request.",
    },
  });
});

it("does not evaluate protocol-envelope accessors", async () => {
  const request = {
    intent: "interface-overview",
    request: {},
    get protocolVersion(): string {
      throw new Error("protocol version getter was evaluated");
    },
  };

  await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
    outcome: { status: "unsupported", reason: "invalid-request" },
  });
});

it("does not enumerate protocol-envelope keys", async () => {
  const request = new Proxy(
    {
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "interface-overview",
      request: {
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/focused",
      },
    },
    {
      ownKeys(): never {
        throw new Error("protocol envelope keys were enumerated");
      },
    },
  );

  await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
    outcome: { status: "success", result: { intent: "interface-overview" } },
  });
});

it("turns hostile protocol-envelope descriptors into an invalid request", async () => {
  const request = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(): never {
        throw new Error("protocol envelope descriptor is unavailable");
      },
    },
  );

  await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
    outcome: { status: "unsupported", reason: "invalid-request" },
  });
});

it("tolerates unknown protocol-envelope fields without reading them", async () => {
  const request = {
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "interface-overview",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
    },
    get futureTransportMetadata(): never {
      throw new Error("unknown protocol field was evaluated");
    },
  };

  await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
    outcome: { status: "success", result: { intent: "interface-overview" } },
  });
});

it("reads only bounded known fields from the nested inspection request", async () => {
  const request = new Proxy(
    {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
    },
    {
      ownKeys(): never {
        throw new Error("nested request keys were enumerated");
      },
    },
  );

  await expect(
    invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "interface-overview",
      request,
    }),
  ).resolves.toMatchObject({
    outcome: { status: "success", result: { intent: "interface-overview" } },
  });
});

it("keeps exported protocol vocabularies immutable at runtime", async () => {
  expect(() => (INSPECTION_INTENTS as unknown as string[]).push("runtime-execution")).toThrow(
    TypeError,
  );
  expect(Reflect.set(inspectCapabilities(), "protocolVersion", "999")).toBe(false);

  expect(inspectCapabilities().protocolVersion).toBe(INSPECTION_PROTOCOL_VERSION);
  await expect(
    invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "runtime-execution",
      request: {},
    }),
  ).resolves.toMatchObject({
    outcome: { status: "unsupported", reason: "invalid-request" },
  });
});
