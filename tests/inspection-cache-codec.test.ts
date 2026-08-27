import ts from "@typescript/typescript6";
import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import {
  createInspectionCacheIdentity,
  createInspectionCacheWriteReceipt,
  readInspectionCacheHitNotice,
} from "#typepeek/inspection/inspection-cache";
import {
  CACHE_SCHEMA_VERSION,
  readInspectionCacheEnvelope,
  readInspectionCachePayload,
  readInspectionCacheWriteReceiptMessage,
} from "#typepeek/inspection/inspection-cache-codec";
import type { InspectableModuleSelection } from "#typepeek/inspection/installed-evidence";
import {
  type InstalledEvidenceProof,
  MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import type { AnalysisRequest } from "#typepeek/inspection/protocol";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";

const request: AnalysisRequest = {
  intent: "interface-overview",
  request: {
    accessStyle: "import",
    resolutionContext: "/consumer",
    specifier: "example",
  },
};
const selection = {
  declarationPath: "/repository/node_modules/example/index.d.ts",
  declarationRoot: "/repository/node_modules/example",
  kind: "package",
  repositoryRoot: "/repository",
  resolutionContextDirectory: "/consumer",
  resultIdentity: { packageIdentity: { name: "example", version: "1.2.3" } },
} as unknown as InspectableModuleSelection;

it("preserves canonical cache identity serialization and its SHA-256 key", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  const expectedSerialized = JSON.stringify({
    budgetPolicy: INSPECTION_BUDGET_POLICY.identity,
    cacheSemanticsVersion: "2",
    compilerVersion: ts.version,
    evidence: {
      declarationPath: "/repository/node_modules/example/index.d.ts",
      declarationRoot: "/repository/node_modules/example",
      kind: "package",
      repositoryRoot: "/repository",
      resolutionContextDirectory: "/consumer",
      resultIdentity: { packageIdentity: { name: "example", version: "1.2.3" } },
    },
    request: {
      intent: "interface-overview",
      request: {
        accessStyle: "import",
        resolutionContext: "/consumer",
        specifier: "example",
      },
    },
    typepeekVersion: TYPEPEEK_VERSION,
  });

  expect(identity).toBeDefined();
  expect(identity?.serialized).toBe(expectedSerialized);
  expect(identity?.key).toBe(createHash("sha256").update(expectedSerialized).digest("hex"));
});

it("retains the authenticated cache envelope and payload structure", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  expect(identity).toBeDefined();
  if (identity === undefined) {
    return;
  }
  const payload = {
    identity: identity.value,
    outcome: { status: "success", result: { intent: "interface-overview" } },
    proof: { directories: [], files: [], resolutions: [] },
  };
  const serializedPayload = JSON.stringify(payload);
  const envelope = {
    integrity: "a".repeat(64),
    payload: serializedPayload,
    schemaVersion: CACHE_SCHEMA_VERSION,
  };

  expect(readInspectionCacheEnvelope(envelope)).toEqual(envelope);
  expect(readInspectionCachePayload(payload)).toEqual(payload);
  expect(readInspectionCacheEnvelope({ ...envelope, extra: true })).toBeUndefined();
  expect(readInspectionCacheEnvelope({ ...envelope, schemaVersion: 2 })).toBeUndefined();
  expect(
    readInspectionCacheEnvelope({ ...envelope, integrity: envelope.integrity.toUpperCase() }),
  ).toBeUndefined();
  expect(readInspectionCachePayload({ ...payload, extra: true })).toBeUndefined();
  expect(
    readInspectionCachePayload({
      ...payload,
      identity: { ...payload.identity, extra: true },
    }),
  ).toBeUndefined();
  expect(
    readInspectionCachePayload({
      ...payload,
      proof: { ...payload.proof, extra: true },
    }),
  ).toBeUndefined();
});

it("enforces request exactness and the evidence-kind result identity relationship", () => {
  expect(
    createInspectionCacheIdentity(
      {
        ...request,
        extra: true,
      } as unknown as AnalysisRequest,
      selection,
    ),
  ).toBeUndefined();
  expect(
    createInspectionCacheIdentity(request, {
      ...selection,
      kind: "platform",
      resultIdentity: { packageIdentity: { name: "example" } },
    } as unknown as InspectableModuleSelection),
  ).toBeUndefined();
  expect(
    createInspectionCacheIdentity(request, {
      ...selection,
      kind: "platform",
      resultIdentity: { declarationProvider: { name: "@types/node" } },
    } as unknown as InspectableModuleSelection),
  ).toBeDefined();
});

it("rejects excess cache-hit IPC fields and inherited accessors", () => {
  const key = "a".repeat(64);
  expect(readInspectionCacheHitNotice({ kind: "inspection-cache-hit", key })).toEqual({
    kind: "inspection-cache-hit",
    key,
  });
  expect(readInspectionCacheHitNotice({ kind: "inspection-cache-hit", key, extra: true })).toBe(
    undefined,
  );

  let ownKindReads = 0;
  const accessor = { key } as Record<string, unknown>;
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      ownKindReads += 1;
      return "inspection-cache-hit";
    },
  });
  expect(readInspectionCacheHitNotice(accessor)).toBeUndefined();
  expect(ownKindReads).toBe(0);

  let kindReads = 0;
  const inherited = Object.create({
    get kind() {
      kindReads += 1;
      throw new Error("inherited cache-hit kind evaluated");
    },
  });

  expect(() => readInspectionCacheHitNotice(inherited)).not.toThrow();
  expect(readInspectionCacheHitNotice(inherited)).toBeUndefined();
  expect(kindReads).toBe(0);
});

it("accepts exact bounded write receipts including shared acyclic evidence", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  expect(identity).toBeDefined();
  if (identity === undefined) {
    return;
  }
  const file = {
    kind: "declaration",
    path: "/repository/node_modules/example/index.d.ts",
    sha256: "a".repeat(64),
  } as const;
  const receipt = createInspectionCacheWriteReceipt(identity, {
    directories: [],
    files: [file, file],
    resolutions: [],
  });

  expect(receipt).toBeDefined();
  expect(readInspectionCacheWriteReceiptMessage(receipt)).toEqual(receipt);
});

it("rejects sparse, cyclic, oversized, excess, and malformed write-receipt evidence", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  expect(identity).toBeDefined();
  if (identity === undefined) {
    return;
  }
  const sha256 = "a".repeat(64);
  const validProof: InstalledEvidenceProof = {
    directories: [],
    files: [],
    resolutions: [],
  };
  const receipt = createInspectionCacheWriteReceipt(identity, validProof);
  expect(receipt).toBeDefined();
  if (receipt === undefined) {
    return;
  }

  const sparseFiles: unknown[] = [];
  sparseFiles.length = 1;
  expect(
    readInspectionCacheWriteReceiptMessage({
      ...receipt,
      proof: { ...validProof, files: sparseFiles },
    }),
  ).toBeUndefined();

  const cyclicFile: Record<string, unknown> = {
    kind: "declaration",
    path: "/repository/index.d.ts",
    sha256,
  };
  cyclicFile["cycle"] = cyclicFile;
  expect(
    readInspectionCacheWriteReceiptMessage({
      ...receipt,
      proof: { ...validProof, files: [cyclicFile] },
    }),
  ).toBeUndefined();

  expect(
    readInspectionCacheWriteReceiptMessage({
      ...receipt,
      proof: {
        ...validProof,
        files: [
          {
            kind: "declaration",
            path: `/${"x".repeat(4_096)}`,
            sha256,
          },
        ],
      },
    }),
  ).toBeUndefined();

  expect(
    createInspectionCacheWriteReceipt(identity, {
      ...validProof,
      extra: true,
    } as unknown as InstalledEvidenceProof),
  ).toBeUndefined();
  expect(
    createInspectionCacheWriteReceipt(identity, {
      ...validProof,
      directories: [{ entries: -1, path: "/repository", sha256 }],
    }),
  ).toBeUndefined();
  expect(
    createInspectionCacheWriteReceipt(identity, {
      ...validProof,
      files: [{ kind: "manifest", path: "/repository/package.json", sha256: sha256.toUpperCase() }],
    }),
  ).toBeUndefined();
});

it("does not emit a cache write receipt beyond the aggregate directory-entry budget", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  const sha256 = "a".repeat(64);

  expect(identity).toBeDefined();
  if (identity === undefined) {
    return;
  }

  expect(
    createInspectionCacheWriteReceipt(identity, {
      directories: [
        { entries: 2_048, path: "/repository/a", sha256 },
        { entries: 2_048, path: "/repository/b", sha256 },
      ],
      files: [],
      resolutions: [],
    }),
  ).toBeDefined();
  expect(
    createInspectionCacheWriteReceipt(identity, {
      directories: [
        { entries: 3_000, path: "/repository/a", sha256 },
        { entries: 3_000, path: "/repository/b", sha256 },
      ],
      files: [],
      resolutions: [],
    }),
  ).toBeUndefined();
});

it("rejects a proof beyond its own byte limit even when the outer receipt remains bounded", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  expect(identity).toBeDefined();
  if (identity === undefined) {
    return;
  }
  const proof = {
    directories: [],
    files: Array.from({ length: 18 }, (_, index) => ({
      kind: "declaration" as const,
      path: `/${index}-${"x".repeat(3_700)}`,
      sha256: "a".repeat(64),
    })),
    resolutions: [],
  };
  const receipt = {
    identity: identity.value,
    kind: "inspection-cache-write",
    proof,
  };

  expect(Buffer.byteLength(JSON.stringify(proof))).toBeGreaterThan(
    MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
  );
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(96 * 1_024);
  expect(createInspectionCacheWriteReceipt(identity, proof)).toBeUndefined();
  expect(readInspectionCacheWriteReceiptMessage(receipt)).toBeUndefined();
});

it("does not observe inherited toJSON behavior while validating hostile evidence", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  expect(identity).toBeDefined();
  if (identity === undefined) {
    return;
  }
  const receipt = {
    identity: identity.value,
    kind: "inspection-cache-write",
    proof: { directories: [], files: [], resolutions: [] },
  };
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let reads = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    get() {
      reads += 1;
      return undefined;
    },
  });

  try {
    expect(readInspectionCacheWriteReceiptMessage(receipt)).toEqual(receipt);
    expect(reads).toBe(0);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    } else {
      Object.defineProperty(Object.prototype, "toJSON", previous);
    }
  }
});
