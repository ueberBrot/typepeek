import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import {
  INSPECTION_PROTOCOL_VERSION,
  INSPECTION_INTENTS,
  comparePublicInterfaces,
  inspectCapabilities,
  inspectExport,
  invokeInspectionProtocol,
  type InspectionIntent,
  type InspectionProtocolRequest,
} from "#typepeek/inspection";

import { type CompiledPackageFixture, materializeCompiledPackageFixture } from "./helpers/index.ts";

let fixture: CompiledPackageFixture;

beforeAll(async () => {
  fixture = await materializeCompiledPackageFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
});

function exampleInCurrentResolutionContext(intent: InspectionIntent, example: unknown): unknown {
  const record = example as Readonly<Record<string, unknown>>;
  if (intent === "public-interface-comparison") {
    return {
      before: targetInCurrentResolutionContext(record["before"]),
      after: targetInCurrentResolutionContext(record["after"]),
    };
  }
  return { ...record, resolutionContext: process.cwd() };
}

function targetInCurrentResolutionContext(value: unknown): Readonly<Record<string, unknown>> {
  return { ...(value as Readonly<Record<string, unknown>>), resolutionContext: process.cwd() };
}

it("publishes deterministic adapter capabilities without TypeScript enums", () => {
  expect(inspectCapabilities()).toMatchObject({
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
      "public-interface-comparison",
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
    requestDescriptors: expect.arrayContaining([
      {
        intent: "signature-inspection",
        fields: [
          {
            name: "resolutionContext",
            kind: "string",
            required: true,
            format: "absolute-path",
          },
          { name: "specifier", kind: "string", required: true },
          {
            name: "accessStyle",
            kind: "enum",
            required: false,
            values: ["import", "require"],
            default: "import",
          },
          { name: "exportName", kind: "string", required: true },
        ],
        example: {
          resolutionContext: "/absolute/path/to/consumer",
          specifier: "zod",
          exportName: "ZodError",
        },
      },
      {
        intent: "public-interface-comparison",
        fields: [
          {
            name: "before",
            kind: "inspection-target",
            required: true,
            resolutionContextFormat: "absolute-path",
          },
          {
            name: "after",
            kind: "inspection-target",
            required: true,
            resolutionContextFormat: "absolute-path",
          },
        ],
        example: {
          before: {
            resolutionContext: "/absolute/path/to/before-consumer",
            specifier: "zod",
          },
          after: {
            resolutionContext: "/absolute/path/to/after-consumer",
            specifier: "zod",
          },
        },
      },
    ]),
    responseOptions: [
      {
        name: "signatureEvidence",
        appliesTo: ["signature-inspection", "inspection-plan"],
        values: ["structured", "exact", "both"],
        default: "structured",
      },
    ],
  });
});

it("keeps every published request example accepted by the Inspection Protocol", async () => {
  for (const descriptor of inspectCapabilities().requestDescriptors) {
    const response = await invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: descriptor.intent,
      request: exampleInCurrentResolutionContext(descriptor.intent, descriptor.example),
    });

    expect("reason" in response.outcome ? response.outcome.reason : undefined).not.toBe(
      "invalid-request",
    );
  }
});

it("types explicit evidence only where the protocol accepts it", () => {
  const request: InspectionProtocolRequest = {
    protocolVersion: "1",
    intent: "signature-inspection",
    request: {
      resolutionContext: process.cwd(),
      specifier: "execa",
      exportName: "execa",
    },
    response: { signatureEvidence: "both" },
  };
  type OverviewRequest = Extract<InspectionProtocolRequest, { intent: "interface-overview" }>;

  expect(request.response?.signatureEvidence).toBe("both");
  expect(undefined satisfies OverviewRequest["response"]).toBeUndefined();
});

it("dispatches Public Interface comparison through the Inspection Protocol", async () => {
  const request = {
    before: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/conditional",
      accessStyle: "import",
    },
    after: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/conditional",
      accessStyle: "require",
    },
  } as const;

  const direct = await comparePublicInterfaces(request);
  await expect(
    invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "public-interface-comparison",
      request,
    }),
  ).resolves.toEqual({ protocolVersion: INSPECTION_PROTOCOL_VERSION, outcome: direct });
});

it.each([
  {
    evidence: undefined,
    expectedEvidence: "structured",
    expectedKeys: ["kind", "typeParameters", "parameters", "returns"],
    omittedKey: "text",
  },
  {
    evidence: "structured",
    expectedEvidence: "structured",
    expectedKeys: ["kind", "typeParameters", "parameters", "returns"],
    omittedKey: "text",
  },
  {
    evidence: "exact",
    expectedEvidence: "exact",
    expectedKeys: ["kind", "text"],
    omittedKey: "parameters",
  },
  {
    evidence: "both",
    expectedEvidence: "both",
    expectedKeys: ["kind", "text", "typeParameters", "parameters", "returns"],
    omittedKey: undefined,
  },
] as const)(
  "projects $expectedEvidence Signature Evidence without changing Inspection Core",
  async ({ evidence, expectedEvidence, expectedKeys, omittedKey }) => {
    const response = await invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "signature-inspection",
      request: {
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/focused",
        exportName: "createWidget",
      },
      ...(evidence === undefined ? {} : { response: { signatureEvidence: evidence } }),
    });

    expect(response).toMatchObject({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      projection: { signatureEvidence: expectedEvidence },
      outcome: { status: "success", result: { intent: "signature-inspection" } },
    });
    if (response.outcome.status !== "success") {
      return;
    }
    const result = response.outcome.result;
    if (result.intent !== "signature-inspection") {
      return;
    }
    const signature = result.moduleExport.signatures[0];
    expect(Object.keys(signature ?? {})).toEqual(expect.arrayContaining([...expectedKeys]));
    if (omittedKey !== undefined) {
      expect(signature).not.toHaveProperty(omittedKey);
    }
  },
);

it("applies Signature Evidence projection to Signature Inspections inside a plan", async () => {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "inspection-plan",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
      queries: [{ intent: "signature-inspection", exportName: "createWidget" }],
    },
  });

  expect(response).toMatchObject({
    projection: { signatureEvidence: "structured" },
    outcome: {
      status: "success",
      result: {
        intent: "inspection-plan",
        inspections: [{ intent: "signature-inspection" }],
      },
    },
  });
  expect(JSON.stringify(response)).not.toContain('"text":');
});

it("rejects Signature Evidence projection for unrelated intents", async () => {
  await expect(
    invokeInspectionProtocol({
      protocolVersion: INSPECTION_PROTOCOL_VERSION,
      intent: "interface-overview",
      request: {
        resolutionContext: fixture.resolutionContext,
        specifier: "@typepeek-fixture/focused",
      },
      response: { signatureEvidence: "structured" },
    }),
  ).resolves.toMatchObject({
    outcome: { status: "unsupported", reason: "invalid-request" },
  });
});

it("accepts Signature Evidence projection as a no-op for plans without signatures", async () => {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "inspection-plan",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
      queries: [{ intent: "interface-overview" }],
    },
    response: { signatureEvidence: "exact" },
  });

  expect(response).toMatchObject({
    projection: { signatureEvidence: "exact" },
    outcome: {
      status: "success",
      result: {
        intent: "inspection-plan",
        inspections: [{ intent: "interface-overview" }],
      },
    },
  });
});

it("returns executable narrower requests after Supporting Type exhaustion", async () => {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "export-inspection",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/deep-supporting-types",
      exportName: "inspect",
    },
  });

  expect(response).toMatchObject({
    outcome: {
      status: "limit-exceeded",
      exceededBudget: "supporting-type-depth",
    },
    recovery: [
      {
        reason: "inspect-declarations-without-supporting-types",
        request: {
          protocolVersion: "1",
          intent: "declaration-inspection",
          request: {
            resolutionContext: fixture.resolutionContext,
            specifier: "@typepeek-fixture/deep-supporting-types",
            accessStyle: "import",
            exportName: "inspect",
          },
        },
      },
      {
        reason: "inspect-signatures-without-supporting-types",
        request: {
          protocolVersion: "1",
          intent: "signature-inspection",
          response: { signatureEvidence: "structured" },
        },
      },
    ],
  });
  const suggested = response.recovery?.[1]?.request;
  const recovered = await invokeInspectionProtocol(suggested);
  expect(recovered).toMatchObject({
    outcome: {
      status: "success",
      result: { intent: "signature-inspection" },
    },
  });
});

it("returns an executable non-empty Export Search after an exact export miss", async () => {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "signature-inspection",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
      exportName: "WidgetF",
    },
  });

  expect(response).toMatchObject({
    outcome: { status: "not-found", reason: "export-not-found" },
    recovery: [
      {
        reason: "search-related-export-names",
        request: {
          protocolVersion: "1",
          intent: "export-search",
          request: { query: "WidgetF" },
        },
      },
    ],
  });
  const recovered = await invokeInspectionProtocol(response.recovery?.[0]?.request);
  expect(recovered).toMatchObject({
    outcome: {
      status: "success",
      result: {
        intent: "export-search",
        matches: expect.arrayContaining([{ name: "WidgetFactory" }]),
      },
    },
  });
});

it("returns executable Export Search recovery after a Member Inspection export miss", async () => {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "member-inspection",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
      exportName: "WidgetF",
      memberPath: ["create"],
    },
  });

  const recovered = await invokeInspectionProtocol(response.recovery?.[0]?.request);
  expect(recovered).toMatchObject({
    outcome: {
      status: "success",
      result: {
        intent: "export-search",
        matches: expect.arrayContaining([{ name: "WidgetFactory" }]),
      },
    },
  });
});

it("omits Export Search recovery when the missing export cannot be a valid query", async () => {
  const response = await invokeInspectionProtocol({
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
    intent: "signature-inspection",
    request: {
      resolutionContext: fixture.resolutionContext,
      specifier: "@typepeek-fixture/focused",
      exportName: "x".repeat(257),
    },
  });

  expect(response).toMatchObject({
    outcome: { status: "not-found", reason: "export-not-found" },
  });
  expect(response.recovery).toBeUndefined();
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
      protocolVersion: "2",
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
      message: 'Inspection protocol version "2" is not supported.',
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
      message: "Inspection received an invalid protocol request.",
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
