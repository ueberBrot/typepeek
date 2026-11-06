import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import type { ExportInspection, InterfaceOverview } from "#typepeek/inspection";
import {
  inspectExport,
  inspectExportMember,
  inspectExportMembers,
  inspectExportSearch,
  inspectExportSignatures,
  inspectInterfaceOverview,
  inspectPlan,
} from "#typepeek/inspection";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import { match } from "./helpers/matchers.ts";
import type { RealPackageCorpus } from "./helpers/real-package-corpus.ts";
import { materializeRealPackageCorpus } from "./helpers/real-package-corpus.ts";
import { materializeStaticInspection } from "./helpers/static-inspection.ts";

interface CorpusQuestion {
  readonly accessStyle?: "import" | "require";
  readonly context?: "legacy" | "root";
  readonly expectedExport?: string;
  readonly expectedInspectionFailure?: {
    readonly message: string;
    readonly status: "limit-exceeded";
  };
  readonly expectedPackage?: string;
  readonly expectedProvider?: string;
  readonly expectedSurface?: RegExp;
  readonly exportName?: string;
  readonly probe: string;
  readonly probeSignatures?: true;
  readonly specifier: string;
}

const QUESTIONS: readonly CorpusQuestion[] = [
  {
    expectedExport: "Ajv",
    expectedPackage: "ajv",
    probe: 'import { Ajv } from "ajv"; new Ajv({ allErrors: true });',
    specifier: "ajv",
  },
  {
    expectedPackage: "ajv",
    expectedSurface: /type JSONType/u,
    exportName: "JSONType",
    probe:
      'import type { JSONType } from "ajv"; const kind: JSONType = "string"; void kind;',
    specifier: "ajv",
  },
  {
    expectedExport: "Command",
    expectedPackage: "commander",
    probe: 'import { Command } from "commander"; new Command("tool");',
    specifier: "commander",
  },
  {
    expectedProvider: "@types/node",
    expectedSurface: /setTimeout/u,
    exportName: "setTimeout",
    probe:
      'import { setTimeout } from "node:timers/promises"; const result: Promise<string> = setTimeout(1, "ready"); void result;',
    probeSignatures: true,
    specifier: "node:timers/promises",
  },
  {
    expectedPackage: "chalk",
    expectedSurface: /ChalkInstance/u,
    exportName: "default",
    probe:
      'import chalk from "chalk"; const colored: string = chalk.red("error");',
    probeSignatures: true,
    specifier: "chalk",
  },
  {
    expectedPackage: "commander",
    expectedSurface: /new \(name\??: string\): Command/u,
    exportName: "Command",
    probe:
      'import { Command } from "commander"; new Command("tool").option("--quiet");',
    probeSignatures: true,
    specifier: "commander",
  },
  {
    expectedPackage: "date-fns",
    expectedSurface: /isDate/u,
    exportName: "isDate",
    probe:
      'import { isDate } from "date-fns"; const valid: boolean = isDate(new Date()); void valid;',
    probeSignatures: true,
    specifier: "date-fns",
  },
  {
    expectedPackage: "date-fns",
    expectedSurface: /addDays/u,
    exportName: "addDays",
    probe:
      'import { addDays } from "date-fns/addDays"; const date: Date = addDays(new Date(), 2);',
    probeSignatures: true,
    specifier: "date-fns/addDays",
  },
  {
    expectedPackage: "date-fns",
    expectedSurface: /eachDayOfInterval/u,
    exportName: "eachDayOfInterval",
    probe:
      'import { eachDayOfInterval } from "date-fns"; const dates: Date[] = eachDayOfInterval({ start: new Date(), end: new Date() }); void dates;',
    probeSignatures: true,
    specifier: "date-fns",
  },
  {
    expectedExport: "publint",
    expectedPackage: "publint",
    probe: 'import { publint } from "publint"; void publint({pkgDir:"."});',
    specifier: "publint",
  },
  {
    expectedPackage: "publint",
    expectedSurface: /formatMessage/u,
    exportName: "formatMessage",
    probe:
      'import { formatMessage } from "publint/utils"; const text: string | undefined = formatMessage({code:"IMPLICIT_INDEX_FORMAT"} as never, {} as never);',
    probeSignatures: true,
    specifier: "publint/utils",
  },
  {
    expectedPackage: "ts-pattern",
    expectedSurface: /isMatching/u,
    exportName: "isMatching",
    probe:
      'import { isMatching } from "ts-pattern"; const check = isMatching("string"); const valid: boolean = check("value"); void valid;',
    probeSignatures: true,
    specifier: "ts-pattern",
  },
  {
    expectedExport: "ZodError",
    expectedPackage: "zod",
    probe: 'import { z } from "zod"; z.string().parse("ok");',
    specifier: "zod",
  },
  {
    expectedPackage: "zod",
    expectedSurface: /ZodError/u,
    exportName: "ZodError",
    probe:
      'import { ZodError } from "zod"; const error: Error = new ZodError([]); void error;',
    specifier: "zod",
  },
  {
    context: "legacy",
    expectedPackage: "zod",
    expectedSurface: /ZodError/u,
    exportName: "ZodError",
    probe:
      'import { ZodError } from "zod"; const error: Error = new ZodError([]); void error;',
    specifier: "zod",
  },
  {
    expectedInspectionFailure: {
      message: "Inspection exceeded its Supporting Type depth limit.",
      status: "limit-exceeded",
    },
    expectedPackage: "express",
    expectedProvider: "@types/express",
    expectedSurface: /json/u,
    exportName: "json",
    probe:
      'import { json } from "express"; const middleware = json(); void middleware;',
    probeSignatures: true,
    specifier: "express",
  },
  {
    expectedPackage: "lodash",
    expectedProvider: "@types/lodash",
    expectedSurface: /isMatchWithCustomizer/u,
    exportName: "isMatchWithCustomizer",
    probe:
      'import type { isMatchWithCustomizer } from "lodash"; const customizer = undefined as unknown as isMatchWithCustomizer; void customizer;',
    probeSignatures: true,
    specifier: "lodash",
  },
  {
    expectedPackage: "react",
    expectedProvider: "@types/react",
    expectedSurface: /isValidElement/u,
    exportName: "isValidElement",
    probe:
      'import { isValidElement } from "react"; const valid: boolean = isValidElement(null); void valid;',
    probeSignatures: true,
    specifier: "react",
  },
  {
    expectedPackage: "jsonwebtoken",
    expectedProvider: "@types/jsonwebtoken",
    expectedSurface: /decode/u,
    exportName: "decode",
    probe:
      'import { decode } from "jsonwebtoken"; const payload = decode("token"); void payload;',
    probeSignatures: true,
    specifier: "jsonwebtoken",
  },
  {
    expectedProvider: "@types/node",
    expectedSurface: /readFile/u,
    exportName: "readFile",
    probe:
      'import { readFile } from "node:fs"; readFile("package.json", "utf8", (_error, text) => void text);',
    probeSignatures: true,
    specifier: "node:fs",
  },
  {
    accessStyle: "require",
    expectedPackage: "ajv",
    expectedSurface: /type JSONType/u,
    exportName: "JSONType",
    probe:
      'import Ajv = require("ajv"); const kind: Ajv.JSONType = "string"; void kind;',
    specifier: "ajv",
  },
];

const SIGNATURE_QUESTIONS = [
  {
    expectedParameters: ["interval:"],
    exportName: "eachDayOfInterval",
    probe:
      'import { eachDayOfInterval } from "date-fns"; eachDayOfInterval({ start: new Date(), end: new Date() });',
    specifier: "date-fns",
  },
  {
    expectedParameters: ["token:", "secretOrPublicKey:"],
    exportName: "verify",
    probe: 'import { verify } from "jsonwebtoken"; verify("token", "secret");',
    specifier: "jsonwebtoken",
  },
  {
    expectedParameters: ["def:"],
    exportName: "ZodError",
    probe: 'import { ZodError } from "zod"; new ZodError([]);',
    specifier: "zod",
  },
] as const;

const assertStaticCorpusQuestions = async function assertStaticCorpusQuestions(
  corpus: RealPackageCorpus,
  inspection: Awaited<ReturnType<typeof materializeStaticInspection>>
): Promise<void> {
  await Array.fromAsync(QUESTIONS, async (question) => {
    const resolutionContext =
      question.context === "legacy"
        ? corpus.legacyWorkspaceContext
        : corpus.resolutionContext;

    const result = await inspection.run({
      adapter: { kind: "source-checkout", sourceCheckout: process.cwd() },
      cliArguments: [
        ...(question.exportName === undefined
          ? [question.specifier]
          : [
              question.probeSignatures === true ? "signatures" : "export",
              question.specifier,
              question.exportName,
            ]),
        ...(question.accessStyle === undefined
          ? []
          : ["--access", question.accessStyle]),
      ],
      diagnosticContext: `real-package corpus Static Inspection ${question.specifier}`,
      resolutionContext,
    });

    const inspectionNames = new Map([
      ["overview", "Interface Overview"],
      ["signatures", "Signature Inspection"],
      ["export", "Export Inspection"],
    ]);

    const focusedIntent =
      question.probeSignatures === true ? "signatures" : "export";

    const intent =
      question.exportName === undefined ? "overview" : focusedIntent;

    expect(result.stdout).toContain(inspectionNames.get(intent));
  });
};

const expectedIdentity = async function expectedIdentity(
  corpus: RealPackageCorpus,
  packageName: string | undefined,
  resolutionContext: string
): Promise<string | undefined> {
  if (packageName === undefined) {
    return undefined;
  }

  return await corpus.packageIdentity(packageName, resolutionContext);
};

const assertCompileProbe = function assertCompileProbe(
  probe: Awaited<ReturnType<RealPackageCorpus["compileProbe"]>>,
  question: CorpusQuestion,
  expectedPackageIdentity: string | undefined,
  expectedProviderIdentity: string | undefined
): void {
  expect([probe.diagnostics, probe.packageIdentity]).toStrictEqual([
    [],
    question.specifier.startsWith("node:")
      ? undefined
      : (expectedProviderIdentity ?? expectedPackageIdentity),
  ]);
};

const inspectCorpusQuestion = async function inspectCorpusQuestion(
  question: CorpusQuestion,
  resolutionContext: string
): Promise<InspectionOutcome<InterfaceOverview | ExportInspection>> {
  const request = {
    resolutionContext,
    specifier: question.specifier,
    ...(question.accessStyle !== undefined && {
      accessStyle: question.accessStyle,
    }),
  } as const;

  return question.exportName === undefined
    ? await inspectInterfaceOverview(request)
    : await inspectExport({ ...request, exportName: question.exportName });
};

const identityLabel = function identityLabel(
  identity:
    | {
        readonly name: string;
        readonly version?: string;
      }
    | undefined
): string | undefined {
  if (identity === undefined) {
    return undefined;
  }

  const generatedText1 =
    identity.version === undefined ? "" : `@${identity.version}`;

  return `${identity.name}${generatedText1}`;
};

const requiredExpectedSurface = function requiredExpectedSurface(
  question: CorpusQuestion
): RegExp {
  if (question.expectedSurface === undefined) {
    throw new Error(
      `Focused corpus question ${question.specifier} has no expected surface.`
    );
  }

  return question.expectedSurface;
};

const assertCorpusResult = function assertCorpusResult(
  result: InterfaceOverview | ExportInspection,
  question: CorpusQuestion,
  expectedPackageIdentity: string | undefined,
  expectedProviderIdentity: string | undefined
): void {
  expect([
    identityLabel(result.packageIdentity),
    identityLabel(result.declarationProvider),
  ]).toStrictEqual([expectedPackageIdentity, expectedProviderIdentity]);

  if (result.intent === "interface-overview") {
    expect(result.moduleExports.map(({ name }) => name)).toContain(
      question.expectedExport
    );

    return;
  }

  expect(JSON.stringify(result.moduleExport)).toMatch(
    requiredExpectedSurface(question)
  );
};

const signatureLabels = function signatureLabels(
  signatures: readonly {
    readonly kind: "call" | "construct";
    readonly text: string;
  }[]
): readonly string[] {
  return signatures.map(({ kind, text }) => `${kind}:${text}`);
};

const assertCorpusOutcome = function assertCorpusOutcome(
  outcome: InspectionOutcome<InterfaceOverview | ExportInspection>,
  probe: Awaited<ReturnType<RealPackageCorpus["compileProbe"]>>,
  question: CorpusQuestion,
  expectedPackageIdentity: string | undefined,
  expectedProviderIdentity: string | undefined
): void {
  if (question.expectedInspectionFailure !== undefined) {
    expect(outcome).toMatchObject(question.expectedInspectionFailure);

    return;
  }

  expect(outcome.status).toBe("success");

  if (outcome.status !== "success") {
    throw new Error("Expected a successful inspection result.");
  }

  assertCorpusResult(
    outcome.result,
    question,
    expectedPackageIdentity,
    expectedProviderIdentity
  );

  if (
    outcome.result.intent === "export-inspection" &&
    question.probeSignatures === true
  ) {
    expect([
      probe.signatures.length > 0,
      signatureLabels(outcome.result.moduleExport.signatures),
    ]).toStrictEqual([true, signatureLabels(probe.signatures)]);
  }
};

const answerCorpusQuestion = async function answerCorpusQuestion(
  corpus: RealPackageCorpus,
  question: CorpusQuestion
): Promise<void> {
  const resolutionContext =
    question.context === "legacy"
      ? corpus.legacyWorkspaceContext
      : corpus.resolutionContext;

  const expectedPackageIdentity = await expectedIdentity(
    corpus,
    question.expectedPackage,
    resolutionContext
  );

  const expectedProviderIdentity = await expectedIdentity(
    corpus,
    question.expectedProvider,
    resolutionContext
  );

  const probe = await corpus.compileProbe({
    ...(question.accessStyle !== undefined && {
      accessStyle: question.accessStyle,
    }),
    resolutionContext,
    source: question.probe,
    specifier: question.specifier,
    ...(question.exportName !== undefined && {
      exportName: question.exportName,
    }),
  });

  assertCompileProbe(
    probe,
    question,
    expectedPackageIdentity,
    expectedProviderIdentity
  );
  const outcome = await inspectCorpusQuestion(question, resolutionContext);
  assertCorpusOutcome(
    outcome,
    probe,
    question,
    expectedPackageIdentity,
    expectedProviderIdentity
  );
};

describe("real-package-corpus", () => {
  describe("pinned real-package corpus", () => {
    let corpus: RealPackageCorpus;
    beforeAll(async () => {
      corpus = await materializeRealPackageCorpus();
    }, 300_000);

    afterAll(async () => {
      await corpus?.cleanup();
    });

    it("discovers the documented ZodError member and inspects its qualified path", async () => {
      const target = {
        exportName: "ZodError",
        resolutionContext: corpus.resolutionContext,
        specifier: "zod",
      };

      const discovery = await inspectExportMembers({
        ...target,
        query: "ISSUE",
      });

      expect(discovery).toMatchObject({
        result: {
          members: [
            { name: "addIssue", spaces: ["type"] },
            { name: "addIssues", spaces: ["type"] },
            { name: "issues", spaces: ["type"] },
          ],
        },
        status: "success",
      });

      const selected = await inspectExportMember({
        ...target,
        memberPath: [{ name: "issues", space: "type" }],
      });

      expect(selected).toMatchObject({
        result: { declarations: [{ text: match.stringContaining("issues") }] },
        status: "success",
      });
    });

    it("pins at least ten deliberately diverse genuine packages through the lockfile", async () => {
      const runtimePackages = corpus.packageNames.filter(
        (packageName) => !packageName.startsWith("@types/")
      );

      expect(runtimePackages).toHaveLength(13);

      const identities = await Promise.all(
        corpus.packageNames.map(
          async (packageName) => await corpus.packageIdentity(packageName)
        )
      );

      const lockedIdentities = await Promise.all(
        corpus.packageNames.map(
          async (packageName) => await corpus.lockedPackageIdentity(packageName)
        )
      );

      expect([new Set(identities).size, identities]).toStrictEqual([
        corpus.packageNames.length,
        lockedIdentities,
      ]);

      const [rootZod, nestedZod] = await Promise.all([
        corpus.packageIdentity("zod"),
        corpus.packageIdentity("zod", corpus.legacyWorkspaceContext),
      ]);

      expect([rootZod, nestedZod, Object.is(rootZod, nestedZod)]).toStrictEqual(
        [
          await corpus.lockedPackageIdentity("zod"),
          await corpus.lockedPackageIdentity("zod", "legacy"),
          false,
        ]
      );
    });

    it("defines at least twenty caller-context questions across the required contexts", () => {
      expect([
        QUESTIONS.length >= 20,
        QUESTIONS.some(({ specifier }) =>
          ["date-fns/addDays", "publint/utils"].includes(specifier)
        ),
        QUESTIONS.some(({ exportName }) => exportName === undefined),
        QUESTIONS.some(({ exportName }) => exportName !== undefined),
        QUESTIONS.some(({ accessStyle }) => accessStyle === "require"),
        QUESTIONS.some(({ accessStyle }) => accessStyle === undefined),
        QUESTIONS.some(({ context }) => context === "legacy"),
        QUESTIONS.filter(
          ({ expectedProvider }) => expectedProvider !== undefined
        ).length >= 4,
        QUESTIONS.some(({ specifier }) => specifier.startsWith("node:")),
        QUESTIONS.filter(({ probeSignatures }) => probeSignatures === true)
          .length >= 10,
      ]).toStrictEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
    });

    it("answers the installed corpus without loading runtimes or consulting external systems", async () => {
      const inspection = await materializeStaticInspection(
        corpus.resolutionContext,
        {
          executableArtifactPaths: [],
          moduleOnlyRoots: [corpus.resolutionContext],
        }
      );

      await expect(
        assertStaticCorpusQuestions(corpus, inspection)
      ).resolves.toBeUndefined();
      await inspection.verifyNoIo();
    }, 120_000);

    it.each(QUESTIONS)(
      "answers $specifier::$exportName consistently with an independent compile probe",
      async (question) => {
        await expect(
          answerCorpusQuestion(corpus, question)
        ).resolves.toBeUndefined();
      },
      20_000
    );

    it.each(SIGNATURE_QUESTIONS)(
      "answers a bounded Signature Inspection for $specifier::$exportName",
      async ({ expectedParameters, exportName, probe: source, specifier }) => {
        const probe = await corpus.compileProbe({
          exportName,
          source,
          specifier,
        });

        expect(probe.diagnostics).toStrictEqual([]);

        const outcome = await inspectExportSignatures({
          exportName,
          resolutionContext: corpus.resolutionContext,
          specifier,
        });

        expect(outcome.status).toBe("success");

        if (outcome.status !== "success") {
          throw new Error("Expected a successful inspection.");
        }

        expect([
          outcome.result.moduleExport.signatures.length > 0,
          outcome.result.moduleExport.signatures.map(({ kind }) => kind),
        ]).toStrictEqual([true, probe.signatures.map(({ kind }) => kind)]);

        const renderedSignatures = signatureLabels(
          outcome.result.moduleExport.signatures
        ).join("\n");

        for (const parameter of expectedParameters) {
          expect(renderedSignatures).toContain(parameter);
        }
      },
      20_000
    );

    it.each([
      ["@aws-sdk/client-s3", "S3Client"],
      ["@aws-sdk/client-ec2", "EC2Client"],
    ])(
      "inspects a constructor in the large %s declaration graph",
      async (specifier, exportName) => {
        const outcome = await inspectExportSignatures({
          exportName,
          resolutionContext: corpus.resolutionContext,
          specifier,
        });

        expect(outcome).toMatchObject({
          result: {
            moduleExport: {
              name: exportName,
              signatures: [match.objectContaining({ kind: "construct" })],
            },
          },
          status: "success",
        });
      }
    );

    it("reuses validated evidence for a focused large SDK query through the CLI", async () => {
      const cacheDirectory = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-sdk-cache-")
      );

      try {
        const args = [
          "src/cli.ts",
          "signatures",
          "@aws-sdk/client-ec2",
          "EC2Client",
          "--workspace",
          corpus.resolutionContext,
          "--json",
        ];

        const env = {
          TYPEPEEK_CACHE_DIRECTORY: cacheDirectory,
          TYPEPEEK_PROFILE: "1",
        };

        const first = await runCommand(process.execPath, args, { env });
        const repeated = await runCommand(process.execPath, args, { env });
        expect([
          decodeJson(Schema.MutableJson, first.stdout),
          repeated.stdout,
          repeated.stderr.includes('"inspection-cache-hit"'),
          repeated.stderr.includes('"program-materialization"'),
        ]).toStrictEqual([
          match.objectContaining({ status: "success" }),
          first.stdout,
          true,
          false,
        ]);
      } finally {
        await rm(cacheDirectory, { force: true, recursive: true });
      }
    });

    it("pages the large SDK export index", async () => {
      const outcome = await inspectInterfaceOverview({
        cursor: "start",
        resolutionContext: corpus.resolutionContext,
        specifier: "@aws-sdk/client-ec2",
      });

      expect(outcome).toMatchObject({
        result: {
          exportPage: { complete: false, nextCursor: match.any(String) },
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExports.length,
        requireDefined(outcome.result.exportPage?.totalModuleExports) > 8000,
      ]).toStrictEqual([100, true]);
    });

    it("searches the large SDK export index by name", async () => {
      const outcome = await inspectExportSearch({
        query: "EC2Client",
        resolutionContext: corpus.resolutionContext,
        specifier: "@aws-sdk/client-ec2",
      });

      expect(outcome).toMatchObject({
        result: {
          matches: match.arrayContaining([{ name: "EC2Client" }]),
        },
        status: "success",
      });
    });

    it("combines a large SDK export page and focused signature in one Inspection Plan", async () => {
      const outcome = await inspectPlan({
        queries: [
          { cursor: "start", intent: "interface-overview" },
          { exportName: "EC2Client", intent: "signature-inspection" },
        ],
        resolutionContext: corpus.resolutionContext,
        specifier: "@aws-sdk/client-ec2",
      });

      expect(outcome).toMatchObject({
        result: {
          inspections: [
            { exportPage: { complete: false, nextCursor: match.any(String) } },
            {
              moduleExport: {
                name: "EC2Client",
                signatures: [match.objectContaining({ kind: "construct" })],
              },
            },
          ],
        },
        status: "success",
      });
    });
  });
});
