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
  encodeInspectionCacheWriteReceipt,
  readInspectionCacheEnvelope,
  readInspectionCachePayload,
  readInspectionCacheWriteReceiptMessage,
} from "#typepeek/inspection/inspection-cache-codec";
import type { InspectableModuleSelection } from "#typepeek/inspection/installed-evidence";
import {
  type InstalledEvidenceProof,
  MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import {
  compactEvidenceProof,
  expandEvidenceProof,
} from "#typepeek/inspection/installed-evidence-format";
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
  declarationAuthority: {
    declarationPath: "/repository/node_modules/example/index.d.ts",
    root: {
      canonical: "/repository/node_modules/example",
      logical: "/repository/node_modules/example",
    },
  },
  kind: "package",
  repositoryRoot: "/repository",
  resolutionContextDirectory: "/consumer",
  resultIdentity: { packageIdentity: { name: "example", version: "1.2.3" } },
} as unknown as InspectableModuleSelection;

it("transports complete evidence with repeated paths within the receipt budget", () => {
  const identity = createInspectionCacheIdentity(request, selection)!;
  const root = `/repository/${"installed-package/".repeat(80)}`;
  const proof: InstalledEvidenceProof = {
    directories: [],
    files: Array.from({ length: 100 }, (_, index) => ({
      kind: "declaration",
      path: `${root}${index}.d.ts`,
      sha256: "a".repeat(64),
    })),
    resolutions: [],
  };
  expect(Buffer.byteLength(JSON.stringify(proof))).toBeGreaterThan(64 * 1_024);
  const receipt = createInspectionCacheWriteReceipt(identity, proof);
  expect(receipt).toBeDefined();
  const encoded = encodeInspectionCacheWriteReceipt(receipt);
  expect(encoded).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(96 * 1_024);
  expect(readInspectionCacheWriteReceiptMessage(encoded)?.proof).toEqual(proof);
});

it("preserves canonical cache identity serialization and its SHA-256 key", () => {
  const identity = createInspectionCacheIdentity(request, selection);
  const expectedSerialized = JSON.stringify({
    budgetPolicy: INSPECTION_BUDGET_POLICY.identity,
    cacheSemantics: "installed-evidence-proof-file-presence-and-signature-constraints",
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
  for (const cacheSemantics of [
    "installed-evidence-proof-focused-plan-authority",
    "installed-evidence-proof-contextual-export-access",
    "installed-evidence-proof-inferred-type-edges",
    "installed-evidence-proof-format-and-rest-authority",
  ]) {
    expect(
      readInspectionCachePayload({
        ...payload,
        identity: { ...payload.identity, cacheSemantics },
      }),
    ).toBeUndefined();
  }
  expect(readInspectionCacheEnvelope({ ...envelope, extra: true })).toBeUndefined();
  expect(
    readInspectionCacheEnvelope({ ...envelope, schemaVersion: CACHE_SCHEMA_VERSION + 1 }),
  ).toBeUndefined();
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
    files: Array.from({ length: 280 }, (_, index) => ({
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
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1_056 * 1_024);
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

it("separates Member Discovery cache identities by qualified path and search", () => {
  const target = { ...request.request, exportName: "Example" };
  const requests: AnalysisRequest[] = [
    { intent: "member-discovery", request: { ...target, memberPath: [] } },
    { intent: "member-discovery", request: { ...target, memberPath: [], query: "value" } },
    { intent: "member-discovery", request: { ...target, memberPath: ["nested"] } },
    {
      intent: "member-discovery",
      request: { ...target, memberPath: [{ name: "nested", space: "type" }] },
    },
    {
      intent: "member-discovery",
      request: { ...target, memberPath: [{ name: "nested", space: "value" }] },
    },
    {
      intent: "member-inspection",
      request: { ...target, memberPath: [{ name: "nested", space: "type" }] },
    },
  ];
  const keys = requests.map(
    (candidate) => createInspectionCacheIdentity(candidate, selection)?.key,
  );
  expect(keys).not.toContain(undefined);
  expect(new Set(keys).size).toBe(requests.length);
});

it("compacts shared source formats and preserves aliases and absolute ancestor outliers", () => {
  const declarationPath = "/repository/node_modules/example/index.d.ts";
  const logicalPath = "/repository/node_modules/example/alias.d.ts";
  const proof: InstalledEvidenceProof = {
    files: [
      {
        kind: "declaration",
        path: declarationPath,
        sha256: "a".repeat(64),
        sourceFormat: { accessStyle: "require", path: declarationPath },
      },
      {
        kind: "declaration",
        path: "/repository/node_modules/example/other.d.ts",
        sha256: "b".repeat(64),
        sourceFormat: { accessStyle: "import", path: logicalPath },
      },
    ],
    fileChecks: [
      { path: "/package.json", exists: false },
      { path: "/repository", exists: false },
      { path: logicalPath, exists: true, canonicalPath: declarationPath },
    ],
    directories: [],
    resolutions: [],
  };
  const compact = compactEvidenceProof(proof);
  expect(compact.prefix).toBe("/repository/node_modules/example/");
  expect(compact.files[0]?.[3]).toBe("require");
  expect(compact.files[1]?.[3]).toEqual(["import", expect.any(Number)]);
  expect(compact.paths).toContain("/package.json");
  expect(compact.paths).toContain("/repository");
  expect(expandEvidenceProof(compact)).toEqual(proof);
  expect(compactEvidenceProof({ ...proof, files: [...proof.files].reverse() }).prefix).toBe(
    compact.prefix,
  );
  const identity = createInspectionCacheIdentity(request, selection)!;
  const receipt = createInspectionCacheWriteReceipt(identity, proof)!;
  expect(
    readInspectionCacheWriteReceiptMessage(encodeInspectionCacheWriteReceipt(receipt))?.proof,
  ).toEqual(proof);
});

it.each([
  ["/foo\\/a", "/foo\\bar/b"],
  ["/foo//a", "/foo/b"],
])("preserves absolute-looking suffixes when compacting %s and %s", (...paths) => {
  const proof: InstalledEvidenceProof = {
    files: paths.map((path) => ({ kind: "declaration", path, sha256: "a".repeat(64) })),
    fileChecks: [],
    directories: [],
    resolutions: [],
  };
  expect(expandEvidenceProof(compactEvidenceProof(proof))).toEqual(proof);
});

it("rejects invalid dictionary references and excessive proof expansion", () => {
  const identity = createInspectionCacheIdentity(request, selection)!;
  const receipt = { identity: identity.value, kind: "inspection-cache-write" };
  const proof = {
    prefix: "/repository/",
    paths: ["index.d.ts"],
    rootSets: [[0]],
    files: [["declaration", 0, "a".repeat(64), null]],
    directories: [],
    resolutions: [["module", "import", 0, null, "example", 0, 0]],
  };
  expect(readInspectionCacheWriteReceiptMessage({ ...receipt, proof })).toBeDefined();
  const formatted = readInspectionCacheWriteReceiptMessage({
    ...receipt,
    proof: { ...proof, files: [["declaration", 0, "a".repeat(64), ["require", 0]]] },
  });
  expect(formatted?.proof.files[0]?.sourceFormat).toEqual({
    accessStyle: "require",
    path: "/repository/index.d.ts",
  });
  expect(
    readInspectionCacheWriteReceiptMessage(encodeInspectionCacheWriteReceipt(formatted))?.proof,
  ).toEqual(formatted?.proof);
  const checked = readInspectionCacheWriteReceiptMessage({
    ...receipt,
    proof: { ...proof, fileChecks: [[0, false, null]] },
  });
  expect(checked?.proof.fileChecks).toEqual([{ path: "/repository/index.d.ts", exists: false }]);
  expect(
    readInspectionCacheWriteReceiptMessage(encodeInspectionCacheWriteReceipt(checked))?.proof,
  ).toEqual(checked?.proof);
  for (const invalid of [
    { ...proof, files: [["declaration", 1, "a".repeat(64), null]] },
    { ...proof, files: [["declaration", 0, "a".repeat(64), ["require", 1]]] },
    { ...proof, files: [["manifest", 0, "a".repeat(64), ["require", 0]]] },
    { ...proof, rootSets: [[-1]] },
    { ...proof, fileChecks: [[1, false, null]] },
    { ...proof, fileChecks: [[0, "false", null]] },
    { ...proof, fileChecks: [[0, true, 1]] },
    { ...proof, fileChecks: [[0, true, null]] },
    { ...proof, fileChecks: [[0, false, 0]] },
    { ...proof, resolutions: [["module", "import", 0, null, "example", 0, 1]] },
    { ...proof, prefix: "relative/" },
    { ...proof, prefix: "/" + "x".repeat(4_095) },
    {
      ...proof,
      prefix: "/" + "x".repeat(3_500),
      resolutions: Array.from({ length: 1_000 }, () => [
        "module",
        "import",
        0,
        null,
        "example",
        0,
        0,
      ]),
    },
  ]) {
    expect(() =>
      readInspectionCacheWriteReceiptMessage({ ...receipt, proof: invalid }),
    ).not.toThrow();
    expect(readInspectionCacheWriteReceiptMessage({ ...receipt, proof: invalid })).toBeUndefined();
  }
});
