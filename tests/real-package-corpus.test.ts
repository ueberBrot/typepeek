import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  inspectExport,
  inspectInterfaceOverview,
  type InspectionResult,
} from "#typepeek/inspection";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";

import { type RealPackageCorpus, materializeRealPackageCorpus } from "./helpers/index.ts";
import { materializeStaticInspection } from "./helpers/static-inspection.ts";

interface CorpusQuestion {
  readonly accessStyle?: "import" | "require";
  readonly context?: "legacy" | "root";
  readonly expectedExport?: string;
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
    specifier: "ajv",
    expectedExport: "Ajv",
    expectedPackage: "ajv",
    probe: 'import { Ajv } from "ajv"; new Ajv({ allErrors: true });',
  },
  {
    specifier: "ajv",
    exportName: "JSONType",
    expectedPackage: "ajv",
    expectedSurface: /type JSONType/u,
    probe: 'import type { JSONType } from "ajv"; const kind: JSONType = "string"; void kind;',
  },
  {
    specifier: "arktype",
    expectedExport: "type",
    expectedPackage: "arktype",
    probe: 'import { type } from "arktype"; type({ name: "string" });',
  },
  {
    specifier: "arktype",
    exportName: "ParseError",
    expectedPackage: "arktype",
    expectedSurface: /class ParseError/u,
    probe:
      'import { ParseError } from "arktype"; const error: Error = new ParseError("bad"); void error;',
  },
  {
    specifier: "chalk",
    exportName: "default",
    expectedPackage: "chalk",
    expectedSurface: /ChalkInstance/u,
    probeSignatures: true,
    probe: 'import chalk from "chalk"; const colored: string = chalk.red("error");',
  },
  {
    specifier: "commander",
    exportName: "Command",
    expectedPackage: "commander",
    expectedSurface: /new \(name\??: string\): Command/u,
    probeSignatures: true,
    probe: 'import { Command } from "commander"; new Command("tool").option("--quiet");',
  },
  {
    specifier: "date-fns",
    exportName: "isDate",
    expectedPackage: "date-fns",
    expectedSurface: /isDate/u,
    probeSignatures: true,
    probe:
      'import { isDate } from "date-fns"; const valid: boolean = isDate(new Date()); void valid;',
  },
  {
    specifier: "date-fns/addDays",
    exportName: "addDays",
    expectedPackage: "date-fns",
    expectedSurface: /addDays/u,
    probeSignatures: true,
    probe: 'import { addDays } from "date-fns/addDays"; const date: Date = addDays(new Date(), 2);',
  },
  {
    specifier: "execa",
    exportName: "parseCommandString",
    expectedPackage: "execa",
    expectedSurface: /parseCommandString/u,
    probeSignatures: true,
    probe:
      'import { parseCommandString } from "execa"; const command: string[] = parseCommandString("node --version"); void command;',
  },
  {
    specifier: "publint",
    expectedExport: "publint",
    expectedPackage: "publint",
    probe: 'import { publint } from "publint"; void publint({pkgDir:"."});',
  },
  {
    specifier: "publint/utils",
    exportName: "formatMessage",
    expectedPackage: "publint",
    expectedSurface: /formatMessage/u,
    probeSignatures: true,
    probe:
      'import { formatMessage } from "publint/utils"; const text: string | undefined = formatMessage({code:"IMPLICIT_INDEX_FORMAT"} as never, {} as never);',
  },
  {
    specifier: "ts-pattern",
    exportName: "isMatching",
    expectedPackage: "ts-pattern",
    expectedSurface: /isMatching/u,
    probeSignatures: true,
    probe:
      'import { isMatching } from "ts-pattern"; const check = isMatching("string"); const valid: boolean = check("value"); void valid;',
  },
  {
    specifier: "zod",
    expectedExport: "ZodError",
    expectedPackage: "zod",
    probe: 'import { z } from "zod"; z.string().parse("ok");',
  },
  {
    specifier: "zod",
    exportName: "ZodError",
    expectedPackage: "zod",
    expectedSurface: /ZodError/u,
    probe: 'import { ZodError } from "zod"; const error: Error = new ZodError([]); void error;',
  },
  {
    context: "legacy",
    specifier: "zod",
    exportName: "ZodError",
    expectedPackage: "zod",
    expectedSurface: /ZodError/u,
    probe: 'import { ZodError } from "zod"; const error: Error = new ZodError([]); void error;',
  },
  {
    specifier: "express",
    exportName: "json",
    expectedPackage: "express",
    expectedProvider: "@types/express",
    expectedSurface: /json/u,
    probeSignatures: true,
    probe: 'import { json } from "express"; const middleware = json(); void middleware;',
  },
  {
    specifier: "lodash",
    exportName: "isMatchWithCustomizer",
    expectedPackage: "lodash",
    expectedProvider: "@types/lodash",
    expectedSurface: /isMatchWithCustomizer/u,
    probeSignatures: true,
    probe:
      'import type { isMatchWithCustomizer } from "lodash"; const customizer = undefined as unknown as isMatchWithCustomizer; void customizer;',
  },
  {
    specifier: "react",
    exportName: "isValidElement",
    expectedPackage: "react",
    expectedProvider: "@types/react",
    expectedSurface: /isValidElement/u,
    probeSignatures: true,
    probe:
      'import { isValidElement } from "react"; const valid: boolean = isValidElement(null); void valid;',
  },
  {
    specifier: "jsonwebtoken",
    exportName: "decode",
    expectedPackage: "jsonwebtoken",
    expectedProvider: "@types/jsonwebtoken",
    expectedSurface: /decode/u,
    probeSignatures: true,
    probe: 'import { decode } from "jsonwebtoken"; const payload = decode("token"); void payload;',
  },
  {
    specifier: "node:fs",
    exportName: "readFile",
    expectedProvider: "@types/node",
    expectedSurface: /readFile/u,
    probeSignatures: true,
    probe:
      'import { readFile } from "node:fs"; readFile("package.json", "utf8", (_error, text) => void text);',
  },
  {
    accessStyle: "require",
    specifier: "ajv",
    exportName: "JSONType",
    expectedPackage: "ajv",
    expectedSurface: /type JSONType/u,
    probe: 'import Ajv = require("ajv"); const kind: Ajv.JSONType = "string"; void kind;',
  },
];

describe("pinned real-package corpus", () => {
  let corpus: RealPackageCorpus;

  beforeAll(async () => {
    corpus = await materializeRealPackageCorpus();
  }, 300_000);

  afterAll(async () => {
    await corpus?.cleanup();
  });

  it("pins at least ten deliberately diverse genuine packages through the lockfile", async () => {
    const runtimePackages = corpus.packageNames.filter(
      (packageName) => !packageName.startsWith("@types/"),
    );
    expect(runtimePackages).toHaveLength(13);
    const identities = await Promise.all(
      corpus.packageNames.map((packageName) => corpus.packageIdentity(packageName)),
    );
    const lockedIdentities = await Promise.all(
      corpus.packageNames.map((packageName) => corpus.lockedPackageIdentity(packageName)),
    );
    expect(new Set(identities)).toHaveLength(corpus.packageNames.length);
    expect(identities).toEqual(lockedIdentities);
    const [rootZod, nestedZod] = await Promise.all([
      corpus.packageIdentity("zod"),
      corpus.packageIdentity("zod", corpus.legacyWorkspaceContext),
    ]);
    expect(rootZod).toBe(await corpus.lockedPackageIdentity("zod"));
    expect(nestedZod).toBe(await corpus.lockedPackageIdentity("zod", "legacy"));
    expect(rootZod).not.toBe(nestedZod);
  });

  it("defines at least twenty caller-context questions across the required contexts", () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(20);
    expect(
      QUESTIONS.some(({ specifier }) => ["date-fns/addDays", "publint/utils"].includes(specifier)),
    ).toBe(true);
    expect(QUESTIONS.some(({ exportName }) => exportName === undefined)).toBe(true);
    expect(QUESTIONS.some(({ exportName }) => exportName !== undefined)).toBe(true);
    expect(QUESTIONS.some(({ accessStyle }) => accessStyle === "require")).toBe(true);
    expect(QUESTIONS.some(({ accessStyle }) => accessStyle === undefined)).toBe(true);
    expect(QUESTIONS.some(({ context }) => context === "legacy")).toBe(true);
    expect(
      QUESTIONS.filter(({ expectedProvider }) => expectedProvider !== undefined).length,
    ).toBeGreaterThanOrEqual(4);
    expect(QUESTIONS.some(({ specifier }) => specifier.startsWith("node:"))).toBe(true);
    expect(
      QUESTIONS.filter(({ probeSignatures }) => probeSignatures === true).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("answers the installed corpus without loading runtimes or consulting external systems", async () => {
    const inspection = await materializeStaticInspection(corpus.resolutionContext, {
      executableArtifactPaths: [],
      moduleOnlyRoots: [corpus.resolutionContext],
    });
    await assertStaticCorpusQuestions(corpus, inspection);
    await inspection.verifyNoIo();
  }, 120_000);

  it.each(QUESTIONS)(
    "answers $specifier::$exportName consistently with an independent compile probe",
    (question) => answerCorpusQuestion(corpus, question),
    20_000,
  );
});

async function assertStaticCorpusQuestions(
  corpus: RealPackageCorpus,
  inspection: Awaited<ReturnType<typeof materializeStaticInspection>>,
): Promise<void> {
  for (const question of QUESTIONS) {
    const resolutionContext =
      question.context === "legacy" ? corpus.legacyWorkspaceContext : corpus.resolutionContext;
    const result = await inspection.run({
      adapter: { kind: "source-checkout", sourceCheckout: process.cwd() },
      arguments_: [
        question.specifier,
        ...(question.exportName === undefined ? [] : ["--export", question.exportName]),
        ...(question.accessStyle === undefined ? [] : ["--access", question.accessStyle]),
      ],
      diagnosticContext: `real-package corpus Static Inspection ${question.specifier}`,
      resolutionContext,
    });
    expect(result.stdout).toContain(
      question.exportName === undefined ? "Interface Overview" : "Export Inspection",
    );
  }
}

async function answerCorpusQuestion(
  corpus: RealPackageCorpus,
  question: CorpusQuestion,
): Promise<void> {
  const resolutionContext =
    question.context === "legacy" ? corpus.legacyWorkspaceContext : corpus.resolutionContext;
  const expectedPackageIdentity = await expectedIdentity(
    corpus,
    question.expectedPackage,
    resolutionContext,
  );
  const expectedProviderIdentity = await expectedIdentity(
    corpus,
    question.expectedProvider,
    resolutionContext,
  );
  const probe = await corpus.compileProbe({
    ...(question.accessStyle === undefined ? {} : { accessStyle: question.accessStyle }),
    resolutionContext,
    source: question.probe,
    specifier: question.specifier,
    ...(question.exportName === undefined ? {} : { exportName: question.exportName }),
  });
  assertCompileProbe(probe, question, expectedPackageIdentity, expectedProviderIdentity);
  const outcome = await inspectCorpusQuestion(question, resolutionContext);
  assertCorpusOutcome(outcome, probe, question, expectedPackageIdentity, expectedProviderIdentity);
}

function assertCompileProbe(
  probe: Awaited<ReturnType<RealPackageCorpus["compileProbe"]>>,
  question: CorpusQuestion,
  expectedPackageIdentity: string | undefined,
  expectedProviderIdentity: string | undefined,
): void {
  expect(probe.diagnostics).toEqual([]);
  expect(probe.packageIdentity).toBe(
    question.specifier.startsWith("node:")
      ? undefined
      : (expectedProviderIdentity ?? expectedPackageIdentity),
  );
}

function inspectCorpusQuestion(
  question: CorpusQuestion,
  resolutionContext: string,
): Promise<InspectionOutcome> {
  const request = {
    resolutionContext,
    specifier: question.specifier,
    ...(question.accessStyle === undefined ? {} : { accessStyle: question.accessStyle }),
  } as const;
  return question.exportName === undefined
    ? inspectInterfaceOverview(request)
    : inspectExport({ ...request, exportName: question.exportName });
}

function assertCorpusOutcome(
  outcome: InspectionOutcome,
  probe: Awaited<ReturnType<RealPackageCorpus["compileProbe"]>>,
  question: CorpusQuestion,
  expectedPackageIdentity: string | undefined,
  expectedProviderIdentity: string | undefined,
): void {
  expect(outcome.status, JSON.stringify(outcome)).toBe("success");
  if (outcome.status === "success") {
    assertCorpusResult(outcome.result, question, expectedPackageIdentity, expectedProviderIdentity);
    if (outcome.result.intent === "export-inspection" && question.probeSignatures === true) {
      expect(probe.signatures.length).toBeGreaterThan(0);
      expect(signatureLabels(outcome.result.moduleExport.signatures)).toEqual(
        signatureLabels(probe.signatures),
      );
    }
  }
}

function signatureLabels(
  signatures: readonly { readonly kind: "call" | "construct"; readonly text: string }[],
): readonly string[] {
  return signatures.map(({ kind, text }) => `${kind}:${text}`);
}

function expectedIdentity(
  corpus: RealPackageCorpus,
  packageName: string | undefined,
  resolutionContext: string,
): Promise<string | undefined> {
  return packageName === undefined
    ? Promise.resolve(undefined)
    : corpus.packageIdentity(packageName, resolutionContext);
}

function assertCorpusResult(
  result: InspectionResult,
  question: CorpusQuestion,
  expectedPackageIdentity: string | undefined,
  expectedProviderIdentity: string | undefined,
): void {
  expect(identityLabel(result.packageIdentity)).toBe(expectedPackageIdentity);
  expect(identityLabel(result.declarationProvider)).toBe(expectedProviderIdentity);
  if (result.intent === "interface-overview") {
    expect(result.moduleExports.map(({ name }) => name)).toContain(question.expectedExport);
    return;
  }
  expect(JSON.stringify(result.moduleExport)).toMatch(requiredExpectedSurface(question));
}

function requiredExpectedSurface(question: CorpusQuestion): RegExp {
  if (question.expectedSurface === undefined) {
    throw new Error(`Focused corpus question ${question.specifier} has no expected surface.`);
  }
  return question.expectedSurface;
}

function identityLabel(
  identity: { readonly name: string; readonly version?: string } | undefined,
): string | undefined {
  return identity === undefined
    ? undefined
    : `${identity.name}${identity.version === undefined ? "" : `@${identity.version}`}`;
}
