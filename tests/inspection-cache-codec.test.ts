import { createHash } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import type { InspectionCacheSelection } from "#typepeek/inspection/cache/inspection-cache";
import {
  createInspectionCacheIdentity,
  createInspectionCacheWriteReceipt,
  readInspectionCacheHitNotice,
} from "#typepeek/inspection/cache/inspection-cache";
import {
  CACHE_SCHEMA_VERSION,
  encodeInspectionCacheWriteReceipt,
  readInspectionCacheEnvelope,
  readInspectionCachePayload,
  readInspectionCacheWriteReceiptMessage,
} from "#typepeek/inspection/cache/inspection-cache-codec";
import { COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-metadata";
import type { InstalledEvidenceProof } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { MAX_INSTALLED_EVIDENCE_PROOF_BYTES } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import {
  compactEvidenceProof,
  expandEvidenceProof,
} from "#typepeek/inspection/evidence/installed-evidence-format";
import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/model/budget-policy";
import type { AnalysisRequest } from "#typepeek/inspection/model/protocol";
import { TYPEPEEK_VERSION } from "#typepeek/platform/package-metadata";
import { requireDefined } from "#typepeek/shared/defined-value";

import { match } from "./helpers/matchers.ts";
import { defineObjectPrototypeProperty } from "./helpers/prototype-fixture.ts";

const request: AnalysisRequest = {
  intent: "interface-overview",
  request: {
    accessStyle: "import",
    resolutionContext: "/consumer",
    specifier: "example",
  },
};

interface CyclicEvidenceFile {
  readonly kind: "declaration";
  readonly path: string;
  readonly sha256: string;
  cycle?: CyclicEvidenceFile;
}

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
} satisfies InspectionCacheSelection;

describe("inspection-cache-codec", () => {
  it("transports complete evidence with repeated paths within the receipt budget", () => {
    const identity = requireDefined(
      createInspectionCacheIdentity(request, selection)
    );

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

    expect(Buffer.byteLength(JSON.stringify(proof))).toBeGreaterThan(64 * 1024);
    const receipt = createInspectionCacheWriteReceipt(identity, proof);
    expect(receipt).toBeDefined();
    const encoded = encodeInspectionCacheWriteReceipt(receipt);
    expect([
      encoded !== undefined,
      Buffer.byteLength(JSON.stringify(encoded)) < 96 * 1024,
      readInspectionCacheWriteReceiptMessage(encoded)?.proof,
    ]).toStrictEqual([true, true, proof]);
  });

  it("preserves canonical cache identity serialization and its SHA-256 key", () => {
    const identity = createInspectionCacheIdentity(request, selection);

    const expectedSerialized = JSON.stringify({
      budgetPolicy: INSPECTION_BUDGET_POLICY.identity,
      cacheSemantics:
        "installed-evidence-proof-file-presence-and-signature-constraints",
      compilerVersion: COMPILER_VERSION,
      evidence: {
        declarationPath: "/repository/node_modules/example/index.d.ts",
        declarationRoot: "/repository/node_modules/example",
        kind: "package",
        repositoryRoot: "/repository",
        resolutionContextDirectory: "/consumer",
        resultIdentity: {
          packageIdentity: { name: "example", version: "1.2.3" },
        },
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

    expect([
      identity !== undefined,
      identity?.serialized,
      identity?.key,
    ]).toStrictEqual([
      true,
      expectedSerialized,
      createHash("sha256").update(expectedSerialized).digest("hex"),
    ]);
  });

  it("retains the authenticated cache envelope and payload structure", () => {
    const identity = createInspectionCacheIdentity(request, selection);
    expect(identity).toBeDefined();

    if (identity === undefined) {
      return;
    }

    const payload = {
      identity: identity.value,
      outcome: { result: { intent: "interface-overview" }, status: "success" },
      proof: { directories: [], files: [], resolutions: [] },
    };

    const serializedPayload = JSON.stringify(payload);

    const envelope = {
      integrity: "a".repeat(64),
      payload: serializedPayload,
      schemaVersion: CACHE_SCHEMA_VERSION,
    };

    expect([
      readInspectionCacheEnvelope(envelope),
      readInspectionCachePayload(payload),
    ]).toStrictEqual([envelope, payload]);

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
        })
      ).toBeUndefined();
    }

    expect([
      readInspectionCacheEnvelope({ ...envelope, extra: true }) === undefined,
      readInspectionCacheEnvelope({
        ...envelope,
        schemaVersion: CACHE_SCHEMA_VERSION + 1,
      }) === undefined,
      readInspectionCacheEnvelope({
        ...envelope,
        integrity: envelope.integrity.toUpperCase(),
      }) === undefined,
      readInspectionCachePayload({ ...payload, extra: true }) === undefined,
      readInspectionCachePayload({
        ...payload,
        identity: { ...payload.identity, extra: true },
      }) === undefined,
      readInspectionCachePayload({
        ...payload,
        proof: { ...payload.proof, extra: true },
      }) === undefined,
    ]).toStrictEqual([true, true, true, true, true, true]);
  });

  it("enforces request exactness and the evidence-kind result identity relationship", () => {
    const unexpectedRequest = { ...request, extra: true };

    expect([
      createInspectionCacheIdentity(unexpectedRequest, selection) === undefined,
      createInspectionCacheIdentity(request, {
        ...selection,
        kind: "platform",
        resultIdentity: { packageIdentity: { name: "example" } },
      } satisfies InspectionCacheSelection) === undefined,
      createInspectionCacheIdentity(request, {
        ...selection,
        kind: "platform",
        resultIdentity: { declarationProvider: { name: "@types/node" } },
      } satisfies InspectionCacheSelection) !== undefined,
    ]).toStrictEqual([true, true, true]);
  });

  it("rejects excess cache-hit IPC fields and inherited accessors", () => {
    const key = "a".repeat(64);
    expect([
      readInspectionCacheHitNotice({ key, kind: "inspection-cache-hit" }),
      readInspectionCacheHitNotice({
        extra: true,
        key,
        kind: "inspection-cache-hit",
      }) === undefined,
    ]).toStrictEqual([
      {
        key,
        kind: "inspection-cache-hit",
      },
      true,
    ]);
    let ownKindReads = 0;
    const accessor = { key };
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get() {
        ownKindReads += 1;

        return "inspection-cache-hit";
      },
    });
    expect([
      readInspectionCacheHitNotice(accessor) === undefined,
      ownKindReads,
    ]).toStrictEqual([true, 0]);
    let kindReads = 0;

    const inherited = {};
    Object.setPrototypeOf(inherited, {
      get kind() {
        kindReads += 1;
        throw new Error("inherited cache-hit kind evaluated");
      },
    });

    expect(() => readInspectionCacheHitNotice(inherited)).not.toThrow();
    expect([
      readInspectionCacheHitNotice(inherited) === undefined,
      kindReads,
    ]).toStrictEqual([true, 0]);
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

    expect([
      receipt !== undefined,
      readInspectionCacheWriteReceiptMessage(receipt),
    ]).toStrictEqual([true, receipt]);
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
      })
    ).toBeUndefined();

    const cyclicFile: CyclicEvidenceFile = {
      kind: "declaration",
      path: "/repository/index.d.ts",
      sha256,
    };

    cyclicFile.cycle = cyclicFile;

    const unexpectedProof = { ...validProof, extra: true };

    expect([
      readInspectionCacheWriteReceiptMessage({
        ...receipt,
        proof: { ...validProof, files: [cyclicFile] },
      }) === undefined,
      readInspectionCacheWriteReceiptMessage({
        ...receipt,
        proof: {
          ...validProof,
          files: [
            {
              kind: "declaration",
              path: `/${"x".repeat(4096)}`,
              sha256,
            },
          ],
        },
      }) === undefined,
      createInspectionCacheWriteReceipt(identity, unexpectedProof) ===
        undefined,
      createInspectionCacheWriteReceipt(identity, {
        ...validProof,
        directories: [{ entries: -1, path: "/repository", sha256 }],
      }) === undefined,
      createInspectionCacheWriteReceipt(identity, {
        ...validProof,
        files: [
          {
            kind: "manifest",
            path: "/repository/package.json",
            sha256: sha256.toUpperCase(),
          },
        ],
      }) === undefined,
    ]).toStrictEqual([true, true, true, true, true]);
  });

  it("does not emit a cache write receipt beyond the aggregate directory-entry budget", () => {
    const identity = createInspectionCacheIdentity(request, selection);
    const sha256 = "a".repeat(64);
    expect(identity).toBeDefined();

    if (identity === undefined) {
      return;
    }

    expect([
      createInspectionCacheWriteReceipt(identity, {
        directories: [
          { entries: 2048, path: "/repository/a", sha256 },
          { entries: 2048, path: "/repository/b", sha256 },
        ],
        files: [],
        resolutions: [],
      }) !== undefined,
      createInspectionCacheWriteReceipt(identity, {
        directories: [
          { entries: 3000, path: "/repository/a", sha256 },
          { entries: 3000, path: "/repository/b", sha256 },
        ],
        files: [],
        resolutions: [],
      }) === undefined,
    ]).toStrictEqual([true, true]);
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
        path: `/${index}-${"x".repeat(3700)}`,
        sha256: "a".repeat(64),
      })),
      resolutions: [],
    };

    const receipt = {
      identity: identity.value,
      kind: "inspection-cache-write",
      proof,
    };

    expect([
      Buffer.byteLength(JSON.stringify(proof)) >
        MAX_INSTALLED_EVIDENCE_PROOF_BYTES,
      Buffer.byteLength(JSON.stringify(receipt)) < 1056 * 1024,
      createInspectionCacheWriteReceipt(identity, proof) === undefined,
      readInspectionCacheWriteReceiptMessage(receipt) === undefined,
    ]).toStrictEqual([true, true, true, true]);
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

    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON"
    );

    let reads = 0;
    defineObjectPrototypeProperty("toJSON", {
      configurable: true,
      get() {
        reads += 1;
      },
    });

    try {
      expect([
        readInspectionCacheWriteReceiptMessage(receipt),
        reads,
      ]).toStrictEqual([receipt, 0]);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "toJSON");
      } else {
        defineObjectPrototypeProperty("toJSON", previous);
      }
    }
  });

  it("separates Member Discovery cache identities by qualified path and search", () => {
    const target = { ...request.request, exportName: "Example" };

    const requests: AnalysisRequest[] = [
      { intent: "member-discovery", request: { ...target, memberPath: [] } },
      {
        intent: "member-discovery",
        request: { ...target, memberPath: [], query: "value" },
      },
      {
        intent: "member-discovery",
        request: { ...target, memberPath: ["nested"] },
      },
      {
        intent: "member-discovery",
        request: { ...target, memberPath: [{ name: "nested", space: "type" }] },
      },
      {
        intent: "member-discovery",
        request: {
          ...target,
          memberPath: [{ name: "nested", space: "value" }],
        },
      },
      {
        intent: "member-inspection",
        request: { ...target, memberPath: [{ name: "nested", space: "type" }] },
      },
    ];

    const keys = requests.map(
      (candidate) => createInspectionCacheIdentity(candidate, selection)?.key
    );

    expect([keys.includes(undefined), new Set(keys).size]).toStrictEqual([
      false,
      requests.length,
    ]);
  });

  it("compacts shared source formats and preserves aliases and absolute ancestor outliers", () => {
    const declarationPath = "/repository/node_modules/example/index.d.ts";
    const logicalPath = "/repository/node_modules/example/alias.d.ts";

    const proof: InstalledEvidenceProof = {
      directories: [],
      fileChecks: [
        { exists: false, path: "/package.json" },
        { exists: false, path: "/repository" },
        { canonicalPath: declarationPath, exists: true, path: logicalPath },
      ],
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
      resolutions: [],
    };

    const compact = compactEvidenceProof(proof);
    expect([
      compact.prefix,
      Object.is(compact.files[0]?.[3], "require"),
      compact.files[1]?.[3],
      compact.paths.includes("/package.json"),
      compact.paths.includes("/repository"),
      expandEvidenceProof(compact),
      compactEvidenceProof({ ...proof, files: [...proof.files].toReversed() })
        .prefix,
    ]).toStrictEqual([
      "/repository/node_modules/example/",
      true,
      ["import", match.any(Number)],
      true,
      true,
      proof,
      compact.prefix,
    ]);

    const identity = requireDefined(
      createInspectionCacheIdentity(request, selection)
    );

    const receipt = requireDefined(
      createInspectionCacheWriteReceipt(identity, proof)
    );

    expect(
      readInspectionCacheWriteReceiptMessage(
        encodeInspectionCacheWriteReceipt(receipt)
      )?.proof
    ).toStrictEqual(proof);
  });

  it.each([
    ["/foo\\/a", "/foo\\bar/b"],
    ["/foo//a", "/foo/b"],
  ])(
    "preserves absolute-looking suffixes when compacting %s and %s",
    (...paths) => {
      const proof: InstalledEvidenceProof = {
        directories: [],
        fileChecks: [],
        files: paths.map((path) => ({
          kind: "declaration",
          path,
          sha256: "a".repeat(64),
        })),
        resolutions: [],
      };

      expect(expandEvidenceProof(compactEvidenceProof(proof))).toStrictEqual(
        proof
      );
    }
  );

  it("rejects invalid dictionary references and excessive proof expansion", () => {
    const identity = requireDefined(
      createInspectionCacheIdentity(request, selection)
    );

    const receipt = {
      identity: identity.value,
      kind: "inspection-cache-write",
    };

    const proof = {
      directories: [],
      files: [["declaration", 0, "a".repeat(64), null]],
      paths: ["index.d.ts"],
      prefix: "/repository/",
      resolutions: [["module", "import", 0, null, "example", 0, 0]],
      rootSets: [[0]],
    };

    expect(
      readInspectionCacheWriteReceiptMessage({ ...receipt, proof })
    ).toBeDefined();

    const formatted = readInspectionCacheWriteReceiptMessage({
      ...receipt,
      proof: {
        ...proof,
        files: [["declaration", 0, "a".repeat(64), ["require", 0]]],
      },
    });

    expect([
      formatted?.proof.files[0]?.sourceFormat,
      readInspectionCacheWriteReceiptMessage(
        encodeInspectionCacheWriteReceipt(formatted)
      )?.proof,
    ]).toStrictEqual([
      {
        accessStyle: "require",
        path: "/repository/index.d.ts",
      },
      formatted?.proof,
    ]);

    const checked = readInspectionCacheWriteReceiptMessage({
      ...receipt,
      proof: { ...proof, fileChecks: [[0, false, null]] },
    });

    expect([
      checked?.proof.fileChecks,
      readInspectionCacheWriteReceiptMessage(
        encodeInspectionCacheWriteReceipt(checked)
      )?.proof,
    ]).toStrictEqual([
      [{ exists: false, path: "/repository/index.d.ts" }],
      checked?.proof,
    ]);

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
      {
        ...proof,
        resolutions: [["module", "import", 0, null, "example", 0, 1]],
      },
      { ...proof, prefix: "relative/" },
      { ...proof, prefix: `/${"x".repeat(4095)}` },
      {
        ...proof,
        prefix: `/${"x".repeat(3500)}`,
        resolutions: Array.from({ length: 1000 }, () => [
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
        readInspectionCacheWriteReceiptMessage({ ...receipt, proof: invalid })
      ).not.toThrow();
      expect(
        readInspectionCacheWriteReceiptMessage({ ...receipt, proof: invalid })
      ).toBeUndefined();
    }
  });
});
