import { execa } from "execa";
import { createHmac } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type CompiledPackageFixture, materializeCompiledPackageFixture } from "./helpers/index.ts";

const UNSAFE_TERMINAL_CODE_POINTS = new Set([
  ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
  ...Array.from({ length: 33 }, (_, offset) => 0x7f + offset),
  0x061c,
  0x200e,
  0x200f,
  ...Array.from({ length: 7 }, (_, offset) => 0x2028 + offset),
  ...Array.from({ length: 4 }, (_, offset) => 0x2066 + offset),
]);

describe("typepeek CLI", () => {
  let fixture: CompiledPackageFixture;

  beforeAll(async () => {
    fixture = await materializeCompiledPackageFixture();
  }, 30_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("presents the initial command", async () => {
    const result = await execa(process.execPath, ["src/cli.ts", "--help"]);

    expect(result.stdout).toContain("typepeek");
    expect(result.stdout).toContain("Use overview to discover exports");
    expect(result.stdout).toContain("overview");
    expect(result.stdout).toContain("export");
    expect(result.stdout).toContain("signatures");
    expect(result.stdout).toContain("plan");
    expect(result.stdout).toContain("search");
    expect(result.stdout).toContain("subpaths");
    expect(result.stdout).toContain("declarations");
    expect(result.stdout).toContain("member");
    expect(result.stdout).toContain("compare");
    expect(result.stdout).toContain("capabilities");
  });

  it("reports the version declared by the package manifest", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      readonly version: string;
    };
    const result = await execa(process.execPath, ["src/cli.ts", "--version"]);

    expect(result.stdout).toContain(manifest.version);
  });

  it("prints the versioned adapter capabilities", async () => {
    const result = await execa(process.execPath, ["src/cli.ts", "capabilities"]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      intent: "capabilities",
      protocolVersion: "2",
      supportedIntents: expect.arrayContaining([
        "inspection-plan",
        "member-inspection",
        "public-interface-comparison",
      ]),
    });
  });

  it("compares two Interface Overview indexes through the CLI", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "compare",
      "@typepeek-fixture/conditional",
      "@typepeek-fixture/conditional",
      "--before-context",
      fixture.resolutionContext,
      "--after-context",
      fixture.resolutionContext,
      "--before-access",
      "import",
      "--after-access",
      "require",
    ]);

    expect(result.stdout).toContain("Public Interface Comparison");
    expect(result.stdout).toContain("Before Access Style: import");
    expect(result.stdout).toContain("After Access Style: require");
    expect(result.stdout).toContain("+ requireExport");
    expect(result.stdout).toContain("- importExport");
    expect(result.stderr).toBe("");
  });

  it("renders declaration-only inspection", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "declarations",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
    ]);

    expect(result.stdout).toContain("Declaration Inspection");
    expect(result.stdout).toContain("Module Export: createWidget");
    expect(result.stdout).not.toContain("Supporting Types");
    expect(result.stdout).not.toContain("Signatures");
  });

  it("renders one exact public member", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "member",
      "@typepeek-fixture/focused",
      "PublicShape",
      "visible",
      "--context",
      fixture.resolutionContext,
    ]);

    expect(result.stdout).toContain("Member Inspection");
    expect(result.stdout).toContain("Member: PublicShape.visible");
    expect(result.stdout).toContain("readonly visible: VisibleOnly;");
    expect(result.stdout).not.toContain("private readonly secret");
  });

  it("preserves a dotted property name as one exact Member path segment", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "member",
      "@typepeek-fixture/focused",
      "PublicShape",
      "a.b",
      "--context",
      fixture.resolutionContext,
      "--json",
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: {
        intent: "member-inspection",
        moduleExportName: "PublicShape",
        memberPath: ["a.b"],
      },
    });
  });

  it("accepts an unambiguous JSON array for a nested Member path", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "member",
      "@typepeek-fixture/focused",
      "NestedShape",
      '["nested","leaf"]',
      "--context",
      fixture.resolutionContext,
      "--json",
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: {
        intent: "member-inspection",
        moduleExportName: "NestedShape",
        memberPath: ["nested", "leaf"],
      },
    });
  });

  it("searches Module Export names through a focused discovery command", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "search",
      "@typepeek-fixture/focused",
      "error",
      "--context",
      fixture.resolutionContext,
    ]);

    expect(result.stdout).toContain('Module Exports (3 matching "error";');
    expect(result.stdout).toContain("- ErrorFactory");
    expect(result.stdout).not.toContain("Public Subpaths");
  });

  it("discovers Public Subpaths without program materialization", async () => {
    const arguments_ = [
      "src/cli.ts",
      "subpaths",
      "@typepeek-fixture/conditional",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const result = await execa(process.execPath, arguments_, {
      env: { TYPEPEEK_PROFILE: "1" },
    });
    const profile = JSON.parse(result.stderr) as {
      readonly phases: readonly { readonly name: string }[];
    };

    expect(profile.phases.map(({ name }) => name)).not.toContain("program-materialization");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: { intent: "public-subpath-discovery" },
    });
  });

  it("keeps a Public Subpath-only inspection plan manifest-only", async () => {
    const result = await execa(
      process.execPath,
      [
        "src/cli.ts",
        "plan",
        "@typepeek-fixture/conditional",
        JSON.stringify([
          { intent: "public-subpath-discovery" },
          { intent: "public-subpath-discovery" },
        ]),
        "--context",
        fixture.resolutionContext,
        "--json",
      ],
      { env: { TYPEPEEK_PROFILE: "1" } },
    );
    const profile = JSON.parse(result.stderr) as {
      readonly phases: readonly { readonly name: string }[];
    };

    expect(profile.phases.map(({ name }) => name)).not.toContain("program-materialization");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: {
        intent: "inspection-plan",
        inspections: [
          { intent: "public-subpath-discovery" },
          { intent: "public-subpath-discovery" },
        ],
      },
    });
  });

  it("executes an atomic inspection plan from a bounded JSON query list", async () => {
    const arguments_ = [
      "src/cli.ts",
      "plan",
      "@typepeek-fixture/focused",
      JSON.stringify([
        { intent: "interface-overview" },
        { intent: "signature-inspection", exportName: "detailed" },
      ]),
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const result = await execa(process.execPath, arguments_);
    const profiled = await execa(process.execPath, arguments_, {
      env: { TYPEPEEK_PROFILE: "1" },
    });

    expect(result.stderr).toBe("");
    expect(profiled.stdout).toBe(result.stdout);
    const profile = JSON.parse(profiled.stderr) as {
      readonly phases: readonly { readonly name: string }[];
    };
    expect(profile.phases.filter(({ name }) => name === "program-materialization")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: {
        intent: "inspection-plan",
        inspections: [
          { intent: "interface-overview" },
          { intent: "signature-inspection", moduleExport: { name: "detailed" } },
        ],
      },
    });
  });

  it.each([
    [[], "Inspection Plan queries must contain from 1 through 16 entries."],
    [[null], "Each Inspection Plan query must be an object."],
    [[{ intent: "runtime-inspection" }], "Each Inspection Plan query has an unsupported intent."],
    [
      [{ intent: "export-search", query: "" }],
      "Each Export Search query requires a bounded non-empty query string.",
    ],
    [
      [{ intent: "export-inspection" }],
      "Each focused Inspection Plan query requires a string exportName.",
    ],
    [
      [{ intent: "member-inspection", exportName: "Example" }],
      "Each Member Inspection query requires an exportName and memberPath.",
    ],
  ] as const)("preserves the Inspection Plan query diagnostic for %#", async (queries, message) => {
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "plan", "example", JSON.stringify(queries), "--json"],
      { reject: false },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "invalid-invocation",
      message: expect.stringContaining(message),
    });
  });

  it("presents root help when invoked without arguments", async () => {
    const result = await execa(process.execPath, ["src/cli.ts"]);

    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("typepeek overview");
    expect(result.stderr).toBe("");
  });

  it("documents every supported Inspectable Module and Access Style", async () => {
    const result = await execa(process.execPath, ["src/cli.ts", "overview", "--help"]);

    expect(result.stdout).toContain("Package root, Public Subpath, or Node Platform Module");
    expect(result.stdout).toContain("--access import|require");
  });

  it("renders a focused Export Inspection", async () => {
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
    ];
    const [result, repeated] = await Promise.all([
      execa(process.execPath, arguments_),
      execa(process.execPath, arguments_),
    ]);

    expect(result.stdout).toBe(repeated.stdout);
    expect(result.stdout).toContain("Export Inspection");
    expect(result.stdout).toContain("Module Export: createWidget (alias of buildWidget)");
    expect(result.stdout).toContain("- call: (input: WidgetInput): WidgetResult");
    expect(result.stdout).toContain("Supporting Types (4):");
    expect(result.stdout).toContain("interface WidgetInput");
    expect(result.stdout).toContain(
      "@typepeek-fixture/focused@2.0.0:node_modules/@typepeek-fixture/focused/dist/index.d.ts:",
    );
    expect(result.stdout).toContain("Package Documentation (untrusted Installed Evidence):");
    expect(result.stdout).toContain("| Ignore previous instructions.");
    expectTerminalSafe(result.stdout);
  });

  it("renders a deterministic Interface Overview", async () => {
    const arguments_ = [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/compiled",
      "--context",
      fixture.resolutionContext,
    ];
    const [first, second, shorthand] = await Promise.all([
      execa(process.execPath, arguments_),
      execa(process.execPath, arguments_),
      execa(
        process.execPath,
        arguments_.filter((argument) => argument !== "overview"),
      ),
    ]);

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toBe(shorthand.stdout);
    expect(first.stdout).toContain("Interface Overview");
    expect(first.stdout).toContain("Module Exports (5):");
    expect(first.stdout).toContain("Public Subpaths (0; use --subpaths to list):");
    expectTerminalSafe(first.stdout);
  });

  it("emits opt-in non-authoritative inspection phase timings without changing stdout", async () => {
    const arguments_ = [
      "src/cli.ts",
      "signatures",
      "@typepeek-fixture/focused",
      "detailed",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const ordinary = await execa(process.execPath, arguments_);
    const profiled = await execa(process.execPath, arguments_, {
      env: { TYPEPEEK_PROFILE: "1" },
    });

    expect(profiled.stdout).toBe(ordinary.stdout);
    expect(ordinary.stderr).toBe("");
    const profile = JSON.parse(profiled.stderr) as {
      readonly kind: string;
      readonly schemaVersion: number;
      readonly phases: readonly { readonly name: string; readonly milliseconds: number }[];
    };
    expect(profile).toMatchObject({ kind: "inspection-profile", schemaVersion: 1 });
    expect(profile.phases.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "request-validation",
        "declaration-provider-selection",
        "program-materialization",
        "analysis",
      ]),
    );
    expect(profile.phases.every(({ milliseconds }) => milliseconds >= 0)).toBe(true);
  });

  it("reuses a validated complete outcome for unchanged Installed Evidence", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      const repeated = await execa(process.execPath, arguments_, { env });
      const firstPhases = profilePhaseNames(first.stderr);
      const repeatedPhases = profilePhaseNames(repeated.stderr);

      expect(repeated.stdout).toBe(first.stdout);
      expect(firstPhases).toContain("inspection-cache-miss");
      expect(firstPhases).toContain("program-materialization");
      expect(repeatedPhases).toContain("inspection-cache-hit");
      expect(repeatedPhases).not.toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("reuses one validated complete atomic Inspection Plan", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-plan-test-"));
    const arguments_ = [
      "src/cli.ts",
      "plan",
      "@typepeek-fixture/focused",
      JSON.stringify([
        { intent: "interface-overview" },
        { intent: "signature-inspection", exportName: "createWidget" },
      ]),
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-hit");
      expect(profilePhaseNames(repeated.stderr)).not.toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("ignores a corrupted cached outcome instead of treating it as authority", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-corruption-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      const entryName = (await readdir(cacheDirectory)).find((name) => name.endsWith(".json"));
      expect(entryName).toBeDefined();
      const entryPath = join(cacheDirectory, entryName as string);
      const envelope = JSON.parse(await readFile(entryPath, "utf8")) as Record<string, unknown>;
      const payload = JSON.parse(envelope["payload"] as string) as Record<string, unknown>;
      payload["outcome"] = {
        status: "success",
        result: { intent: "interface-overview" },
      };
      envelope["payload"] = JSON.stringify(payload);
      await writeFile(entryPath, JSON.stringify(envelope));

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("ignores an authenticated non-success cache entry", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-failure-entry-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        payload["outcome"] = {
          status: "not-found",
          reason: "export-not-found",
          message: "authenticated stale failure",
        };
      });

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an authenticated cached success for a different request", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-request-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        const outcome = payload["outcome"] as {
          result: Record<string, unknown>;
        };
        outcome.result["specifier"] = "authenticated-wrong-specifier";
      });

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an authenticated cached success for different Installed Evidence", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-identity-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        const outcome = payload["outcome"] as {
          result: { packageIdentity: Record<string, unknown> };
        };
        outcome.result.packageIdentity["name"] = "authenticated-wrong-package";
      });

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an authenticated cached success beyond the process result limit", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-output-limit-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await mutateAuthenticatedCachePayload(cacheDirectory, (payload) => {
        const outcome = payload["outcome"] as {
          result: Record<string, unknown>;
        };
        outcome.result["packageDocumentation"] = {
          provenance: "installed-evidence",
          trust: "untrusted",
          text: "x".repeat(70 * 1_024),
        };
      });

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a successful outcome when optional cache storage is unavailable", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-write-failure-test-"));
    await mkdir(join(cacheDirectory, ".write-lock"));

    try {
      const result = await execa(
        process.execPath,
        [
          "src/cli.ts",
          "overview",
          "@typepeek-fixture/focused",
          "--context",
          fixture.resolutionContext,
          "--json",
        ],
        {
          env: { TYPEPEEK_CACHE_DIRECTORY: cacheDirectory },
        },
      );

      expect(JSON.parse(result.stdout)).toMatchObject({ status: "success" });
      expect((await readdir(cacheDirectory)).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not mutate or use a symlinked cache directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "typepeek-cache-symlink-test-"));
      const target = join(root, "target");
      const cacheDirectory = join(root, "cache");
      await mkdir(target, { mode: 0o755 });
      await symlink(target, cacheDirectory, "dir");
      const modeBefore = (await stat(target)).mode & 0o777;

      try {
        const result = await execa(
          process.execPath,
          [
            "src/cli.ts",
            "overview",
            "@typepeek-fixture/focused",
            "--context",
            fixture.resolutionContext,
            "--json",
          ],
          {
            env: { TYPEPEEK_CACHE_DIRECTORY: cacheDirectory },
          },
        );

        expect(JSON.parse(result.stdout)).toMatchObject({ status: "success" });
        expect((await stat(target)).mode & 0o777).toBe(modeBefore);
        expect(await readdir(target)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reuses complete outcomes backed by transitive installed declarations", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-transitive-test-"));
    const arguments_ = [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/compiled",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-hit");
      expect(profilePhaseNames(repeated.stderr)).not.toContain("program-materialization");
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("invalidates when transitive declaration resolution selects a nearer package", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-resolution-test-"));
    const compiledRoot = join(
      fixture.resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "compiled",
    );
    const rootDependency = join(
      fixture.resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "dependency",
    );
    const nestedNodeModules = join(compiledRoot, "node_modules");
    const nestedDependency = join(nestedNodeModules, "@typepeek-fixture", "dependency");
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/compiled",
      "dependencyExport",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await cp(rootDependency, nestedDependency, { recursive: true });
      const nestedDeclarationPath = join(nestedDependency, "dist", "index.d.ts");
      await writeFile(
        nestedDeclarationPath,
        (await readFile(nestedDeclarationPath, "utf8")).replace(
          "dependencyExport: symbol",
          "dependencyExport: string",
        ),
      );

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).not.toBe(first.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await Promise.all([
        rm(cacheDirectory, { recursive: true, force: true }),
        rm(nestedNodeModules, { recursive: true, force: true }),
      ]);
    }
  });

  it("invalidates Public Subpath discovery when a wildcard directory gains an entry", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-subpaths-test-"));
    const addedDeclaration = join(
      fixture.resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "conditional",
      "dist",
      "patterns",
      "green.d.ts",
    );
    const arguments_ = [
      "src/cli.ts",
      "subpaths",
      "@typepeek-fixture/conditional",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await writeFile(addedDeclaration, "export declare const greenPatternExport: string;\n");

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(first.stdout).not.toContain("@typepeek-fixture/conditional/patterns/green");
      expect(repeated.stdout).toContain("@typepeek-fixture/conditional/patterns/green");
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).not.toContain("program-materialization");
    } finally {
      await Promise.all([
        rm(cacheDirectory, { recursive: true, force: true }),
        rm(addedDeclaration, { force: true }),
      ]);
    }
  });

  it("invalidates Public Subpath discovery when a missing wildcard directory appears", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-new-directory-test-"));
    const patternDirectory = join(
      fixture.resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "conditional",
      "dist",
      "patterns",
    );
    const redDeclaration = join(patternDirectory, "red.d.ts");
    const originalDeclaration = await readFile(redDeclaration, "utf8");
    const arguments_ = [
      "src/cli.ts",
      "subpaths",
      "@typepeek-fixture/conditional",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      await rm(patternDirectory, { recursive: true });
      const first = await execa(process.execPath, arguments_, { env });
      expect((await readdir(cacheDirectory)).some((name) => name.endsWith(".json"))).toBe(true);
      const unchanged = await execa(process.execPath, arguments_, { env });
      expect(unchanged.stdout).toBe(first.stdout);
      expect(profilePhaseNames(unchanged.stderr)).toContain("inspection-cache-hit");
      await mkdir(patternDirectory, { recursive: true });
      await writeFile(redDeclaration, originalDeclaration);

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(first.stdout).not.toContain("@typepeek-fixture/conditional/patterns/red");
      expect(repeated.stdout).toContain("@typepeek-fixture/conditional/patterns/red");
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
    } finally {
      await mkdir(patternDirectory, { recursive: true });
      await Promise.all([
        writeFile(redDeclaration, originalDeclaration),
        rm(cacheDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("invalidates when a consumed declaration changes at the same canonical path", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-declaration-test-"));
    const declarationPath = join(
      fixture.resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "compiled",
      "dist",
      "index.d.ts",
    );
    const originalDeclaration = await readFile(declarationPath, "utf8");
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/compiled",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await writeFile(
        declarationPath,
        originalDeclaration.replace(
          "createWidget(options?: WidgetOptions): string",
          "createWidget(options?: WidgetOptions): number",
        ),
      );

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).not.toBe(first.stdout);
      expect(repeated.stdout).toContain(": number");
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("program-materialization");
    } finally {
      await Promise.all([
        writeFile(declarationPath, originalDeclaration),
        rm(cacheDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("invalidates when a consumed installed manifest changes", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-manifest-test-"));
    const manifestPath = join(
      fixture.resolutionContext,
      "node_modules",
      "@typepeek-fixture",
      "focused",
      "package.json",
    );
    const originalManifest = await readFile(manifestPath, "utf8");
    const changedManifest = {
      ...(JSON.parse(originalManifest) as Record<string, unknown>),
      version: "2.0.1",
    };
    const arguments_ = [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/focused",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env });
      await writeFile(manifestPath, JSON.stringify(changedManifest));

      const repeated = await execa(process.execPath, arguments_, { env });

      expect(repeated.stdout).not.toBe(first.stdout);
      expect(repeated.stdout).toContain('"version":"2.0.1"');
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
    } finally {
      await Promise.all([
        writeFile(manifestPath, originalManifest),
        rm(cacheDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not cache a failed inspection outcome", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-failure-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "missingExport",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const first = await execa(process.execPath, arguments_, { env, reject: false });
      const repeated = await execa(process.execPath, arguments_, { env, reject: false });

      expect(JSON.parse(first.stdout)).toMatchObject({ status: "not-found" });
      expect(repeated.stdout).toBe(first.stdout);
      expect(profilePhaseNames(first.stderr)).toContain("inspection-cache-miss");
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-miss");
      expect((await readdir(cacheDirectory)).some((name) => name.endsWith(".json"))).toBe(false);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("publishes one valid cache entry under concurrent identical inspections", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "typepeek-cache-concurrency-test-"));
    const arguments_ = [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ];
    const env = {
      TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
      TYPEPEEK_PROFILE: "1",
    };

    try {
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => execa(process.execPath, arguments_, { env })),
      );
      const repeated = await execa(process.execPath, arguments_, { env });
      const entryNames = (await readdir(cacheDirectory)).filter((name) => name.endsWith(".json"));
      expect(entryNames).toHaveLength(1);
      const serializedEntry = await readFile(join(cacheDirectory, entryNames[0] as string), "utf8");

      expect(new Set(concurrent.map(({ stdout }) => stdout)).size).toBe(1);
      expect(repeated.stdout).toBe(concurrent[0]?.stdout);
      expect(profilePhaseNames(repeated.stderr)).toContain("inspection-cache-hit");
      expect(() => JSON.parse(serializedEntry)).not.toThrow();
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("lists Public Subpaths after Module Exports only when requested", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "@typepeek-fixture/conditional",
      "--context",
      fixture.resolutionContext,
      "--subpaths",
    ]);

    expect(result.stdout).toContain("Public Subpaths (3):");
    expect(result.stdout).toContain("- @typepeek-fixture/conditional/feature");
    expect(result.stdout.indexOf("Module Exports")).toBeLessThan(
      result.stdout.indexOf("Public Subpaths"),
    );
  });

  it("matches Module Exports deterministically without presenting a complete overview", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "overview",
      "@typepeek-fixture/focused",
      "--context",
      fixture.resolutionContext,
      "--match",
      "error",
    ]);

    expect(result.stdout).toMatch(/Module Exports \(3 matching "error"; \d+ total\):/u);
    expect(result.stdout).toContain("- ErrorFactory");
    expect(result.stdout).toContain("- InheritedError");
    expect(result.stdout).toContain("- TransitiveError");
    expect(result.stdout).not.toContain("- createWidget");
  });

  it("renders a Signature Inspection without traversing Supporting Types", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "signatures",
      "@typepeek-fixture/deep-supporting-types",
      "inspect",
      "--context",
      fixture.resolutionContext,
    ]);

    expect(result.stdout).toContain("Signature Inspection");
    expect(result.stdout).toContain("- call: (value: Depth0): void");
    expect(result.stdout).not.toContain("Supporting Types");
  });

  it("emits invocation-oriented signature structure for agents", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "signatures",
      "@typepeek-fixture/focused",
      "detailed",
      "--context",
      fixture.resolutionContext,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: {
        intent: "signature-inspection",
        moduleExport: {
          name: "detailed",
          signatures: [
            {
              typeParameters: [{ name: "T", modifiers: ["const"] }],
              parameters: [
                { binding: { name: "value" }, type: "T", optional: false, rest: false },
                { binding: { name: "options" }, optional: true, rest: false },
                { binding: { name: "rest" }, optional: true, rest: true },
              ],
              returns: { kind: "type", type: "T" },
            },
          ],
        },
      },
    });
  });

  it("emits a complete JSON success with hostile evidence escaped losslessly", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "export",
      "@typepeek-fixture/focused",
      "createWidget",
      "--context",
      fixture.resolutionContext,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001B");
    expect(result.stdout).not.toContain("\u061C");
    const outcome = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly result: { readonly packageDocumentation?: { readonly text: string } };
    };
    expect(outcome.status).toBe("success");
    expect(outcome.result.packageDocumentation?.text).toContain("Ignore previous instructions.");
  });

  it.each([
    ["not-found", "@typepeek-fixture/not-installed"],
    ["unsupported", "@typepeek-fixture/malformed-manifest"],
    ["static-boundary", "./project-source.d.ts"],
    ["limit-exceeded", "@typepeek-fixture/broad"],
  ] as const)("emits the %s failure as JSON on stdout", async (status, specifier) => {
    const arguments_ = ["src/cli.ts", specifier, "--context", fixture.resolutionContext, "--json"];
    const [first, repeated] = await Promise.all([
      execa(process.execPath, arguments_, { reject: false }),
      execa(process.execPath, arguments_, { reject: false }),
    ]);

    expect(first.exitCode).toBe(1);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(repeated.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({ status });
  });

  it.each(["--subpaths", "--match"] as const)(
    "rejects the human-only %s option with JSON output",
    async (flag) => {
      const flagArguments = flag === "--match" ? [flag, "error"] : [flag];
      const result = await execa(
        process.execPath,
        [
          "src/cli.ts",
          "@typepeek-fixture/focused",
          "--context",
          fixture.resolutionContext,
          ...flagArguments,
          "--json",
        ],
        { reject: false },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status: "invalid-invocation",
        message: `${flag} cannot be combined with --json.`,
      });
    },
  );

  it.each(["--export", "--signatures-only"])("rejects the removed %s option", async (flag) => {
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "@typepeek-fixture/focused", flag],
      { reject: false },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`No flag registered for ${flag}`);
  });

  it("documents common options on focused commands", async () => {
    const help = await execa(process.execPath, ["src/cli.ts", "signatures", "--help"]);

    expect(help.stdout).toContain("typepeek signatures");
    expect(help.stdout).toContain("<specifier> <export-name>");
    expect(help.stdout).toContain("--json");
  });

  it.each(["overview", "export", "signatures"])(
    "inspects a package named %s through the explicit overview route",
    async (specifier) => {
      const result = await execa(
        process.execPath,
        ["src/cli.ts", "overview", specifier, "--context", fixture.resolutionContext, "--json"],
        { reject: false },
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "not-found",
        reason: "specifier-not-found",
        message: `Specifier "${specifier}" is not installed from this Resolution Context.`,
      });
    },
  );

  it("escapes option parsing for an export name beginning with a hyphen", async () => {
    const result = await execa(
      process.execPath,
      [
        "src/cli.ts",
        "signatures",
        "@typepeek-fixture/focused",
        "--context",
        fixture.resolutionContext,
        "--",
        "-missing",
      ],
      { reject: false },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Module Export "-missing" was not found');
  });

  it.each([
    [
      "not-found",
      "@typepeek-fixture/not-installed",
      'Specifier "@typepeek-fixture/not-installed" is not installed from this Resolution Context.',
    ],
    [
      "unsupported",
      "@typepeek-fixture/malformed-manifest",
      "The installed package has no valid Package Identity.",
    ],
    [
      "static-boundary",
      "./project-source.d.ts",
      "The requested Specifier is outside the static Inspectable Module boundary.",
    ],
    ["limit-exceeded", "@typepeek-fixture/broad", "Inspection exceeded its Module Export limit."],
  ] as const)("communicates the %s outcome deterministically", (status, specifier, message) =>
    assertDeterministicFailure(fixture, status, specifier, message),
  );

  it("escapes terminal controls in failed inspection diagnostics", async () => {
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "missing\u001B[31m-package", "--context", fixture.resolutionContext],
      { reject: false },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Specifier "missing\\u{1B}[31m-package"');
    expectTerminalSafe(result.stderr);
  });

  it("escapes terminal controls in invalid invocation diagnostics", async () => {
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "overview", "example", "--access", "invalid\u001B[31m\rFORGED\nNEXT\tTAB"],
      { reject: false },
    );

    expect(result.stderr).toContain(
      'Failed to parse "invalid\\u{1B}[31m\\u{D}FORGED\\u{A}NEXT\\u{9}TAB" for access',
    );
    expectTerminalSafeLine(result.stderr);
  });

  it("bounds invalid invocation diagnostics after terminal escaping", async () => {
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "overview", "example", "--access", "\u001B".repeat(24 * 1_024)],
      { reject: false },
    );

    expect(result.exitCode).toBe(2);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128 * 1_024);
    expect(result.stderr).toContain("CLI diagnostic exceeded its output limit");
    expectTerminalSafe(result.stderr);
  });

  it("uses the conventional usage exit status for invalid invocations", async () => {
    const result = await execa(process.execPath, ["src/cli.ts", "signatures", "arktype"], {
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Expected argument for export-name");
  });

  it("emits invalid invocations as structured diagnostics in machine mode", async () => {
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "signatures", "arktype", "--json"],
      { reject: false },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      status: "invalid-invocation",
      message: "Expected argument for export-name",
    });
  });

  it("accepts common options before an explicit inspection command", async () => {
    const result = await execa(process.execPath, [
      "src/cli.ts",
      "--json",
      "--context",
      fixture.resolutionContext,
      "signatures",
      "@typepeek-fixture/focused",
      "detailed",
    ]);

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      result: {
        intent: "signature-inspection",
        resolutionVariant: { accessStyle: "import" },
        moduleExport: { name: "detailed" },
      },
    });
  });
});

async function assertDeterministicFailure(
  fixture: CompiledPackageFixture,
  status: string,
  specifier: string,
  message: string,
): Promise<void> {
  const arguments_ = ["src/cli.ts", specifier, "--context", fixture.resolutionContext];
  const [first, second] = await Promise.all([
    execa(process.execPath, arguments_, { reject: false }),
    execa(process.execPath, arguments_, { reject: false }),
  ]);
  expect(first.exitCode).not.toBe(0);
  expect(first.stdout).toBe(second.stdout);
  expect(first.stderr).toBe(second.stderr);
  const output = `${first.stdout}\n${first.stderr}`;
  expect(output).toContain(`${status}: ${message}`);
  expectTerminalSafe(output);
}

function expectTerminalSafe(output: string): void {
  expect(
    Array.from(output).some(
      (character) => !isLayoutWhitespace(character) && isUnsafeTerminalCharacter(character),
    ),
  ).toBe(false);
}

function profilePhaseNames(serialized: string): readonly string[] {
  const profile = JSON.parse(serialized) as {
    readonly phases: readonly { readonly name: string }[];
  };
  return profile.phases.map(({ name }) => name);
}

async function mutateAuthenticatedCachePayload(
  cacheDirectory: string,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const entryName = (await readdir(cacheDirectory)).find((name) => name.endsWith(".json"));
  expect(entryName).toBeDefined();
  const entryPath = join(cacheDirectory, entryName as string);
  const envelope = JSON.parse(await readFile(entryPath, "utf8")) as Record<string, unknown>;
  const payload = JSON.parse(envelope["payload"] as string) as Record<string, unknown>;
  mutate(payload);
  const serializedPayload = JSON.stringify(payload);
  const integrityKey = await readFile(join(cacheDirectory, ".integrity-key"), "utf8");
  envelope["payload"] = serializedPayload;
  envelope["integrity"] = createHmac("sha256", integrityKey)
    .update(serializedPayload)
    .digest("hex");
  await writeFile(entryPath, JSON.stringify(envelope));
}

function expectTerminalSafeLine(output: string): void {
  expect(Array.from(output).some(isUnsafeTerminalCharacter)).toBe(false);
}

function isUnsafeTerminalCharacter(character: string): boolean {
  return UNSAFE_TERMINAL_CODE_POINTS.has(character.codePointAt(0) ?? 0);
}

function isLayoutWhitespace(character: string): boolean {
  return character === "\n" || character === "\r" || character === "\t";
}
