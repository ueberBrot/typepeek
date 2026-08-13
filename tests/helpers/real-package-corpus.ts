import ts from "@typescript/typescript6";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { installLockedPackagesWithNpm } from "./package-toolchain.ts";

const CORPUS_WORKSPACE = join(process.cwd(), "tests", "fixtures", "real-package-corpus");
const CORPUS_MANIFEST = join(CORPUS_WORKSPACE, "package.json");
const CORPUS_LOCKFILE = join(CORPUS_WORKSPACE, "package-lock.json");
const CORPUS_LEGACY_MANIFEST = join(CORPUS_WORKSPACE, "workspaces", "legacy", "package.json");

export interface RealPackageCorpus {
  readonly cleanup: () => Promise<void>;
  readonly compileProbe: (options: {
    readonly accessStyle?: "import" | "require";
    readonly resolutionContext?: string;
    readonly source: string;
    readonly specifier: string;
    readonly exportName?: string;
  }) => Promise<{
    readonly diagnostics: readonly string[];
    readonly packageIdentity: string | undefined;
    readonly signatures: readonly ProbeSignature[];
  }>;
  readonly legacyWorkspaceContext: string;
  readonly lockedPackageIdentity: (
    packageName: string,
    context?: "legacy" | "root",
  ) => Promise<string>;
  readonly packageNames: readonly string[];
  readonly packageIdentity: (packageName: string, resolutionContext?: string) => Promise<string>;
  readonly resolutionContext: string;
}

export interface ProbeSignature {
  readonly kind: "call" | "construct";
  readonly text: string;
}

export async function materializeRealPackageCorpus(): Promise<RealPackageCorpus> {
  const packageNames = await corpusDependencyNames();
  const fixtureRoot = await mkdtemp(join(tmpdir(), "typepeek-real-corpus-"));
  const resolutionContext = join(fixtureRoot, "consumer");
  const legacyWorkspaceContext = join(resolutionContext, "workspaces", "legacy");

  try {
    await mkdir(legacyWorkspaceContext, { recursive: true });
    await Promise.all([
      copyFile(CORPUS_MANIFEST, join(resolutionContext, "package.json")),
      copyFile(CORPUS_LOCKFILE, join(resolutionContext, "package-lock.json")),
      copyFile(CORPUS_LEGACY_MANIFEST, join(legacyWorkspaceContext, "package.json")),
    ]);
    await installLockedPackagesWithNpm({
      cacheRoot: fixtureRoot,
      diagnosticContext: `real-package corpus Resolution Context ${resolutionContext}`,
      resolutionContext,
    });
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }

  let probeIndex = 0;
  return {
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
    compileProbe: async ({
      accessStyle = "import",
      resolutionContext: context,
      source,
      specifier,
      exportName,
    }) => {
      const probeContext = context ?? resolutionContext;
      const extension = accessStyle === "import" ? "mts" : "cts";
      const probePath = join(probeContext, `.typepeek-probe-${probeIndex}.${extension}`);
      probeIndex += 1;
      await writeFile(probePath, source);
      const options: ts.CompilerOptions = {
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2024,
        types: ["node"],
      };
      const program = ts.createProgram([probePath], options);
      const checker = program.getTypeChecker();
      const resolution = ts.resolveModuleName(
        specifier,
        probePath,
        options,
        ts.sys,
        undefined,
        undefined,
        accessStyle === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      ).resolvedModule;
      return {
        diagnostics: ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
        packageIdentity:
          resolution?.packageId === undefined
            ? undefined
            : `${resolution.packageId.name}@${resolution.packageId.version}`,
        signatures:
          exportName === undefined
            ? []
            : probeExportSignatures(program, checker, probePath, specifier, exportName),
      };
    },
    legacyWorkspaceContext,
    lockedPackageIdentity: (packageName, context = "root") =>
      lockedPackageIdentity(packageName, context),
    packageNames,
    packageIdentity: (packageName, context = resolutionContext) =>
      visiblePackageIdentity(context, packageName),
    resolutionContext,
  };
}

async function lockedPackageIdentity(
  packageName: string,
  context: "legacy" | "root",
): Promise<string> {
  const packages = (await readManifest(CORPUS_LOCKFILE))["packages"];
  if (!isRecord(packages)) {
    throw new Error(`Corpus lockfile ${CORPUS_LOCKFILE} has no packages index.`);
  }
  const packagePath =
    context === "legacy"
      ? `workspaces/legacy/node_modules/${packageName}`
      : `node_modules/${packageName}`;
  return `${packageName}@${packageVersion(packages[packagePath], packagePath)}`;
}

function probeExportSignatures(
  program: ts.Program,
  checker: ts.TypeChecker,
  probePath: string,
  specifier: string,
  exportName: string,
): readonly ProbeSignature[] {
  const sourceFile = program.getSourceFile(probePath);
  const moduleSpecifier =
    sourceFile === undefined ? undefined : findModuleSpecifier(sourceFile, specifier);
  const symbol = probeExportSymbol(checker, moduleSpecifier, exportName);
  const signatureEvidence =
    symbol === undefined ? undefined : probeSignatureEvidence(checker, symbol);
  if (signatureEvidence === undefined) {
    return [];
  }
  return probeTypeSignatures(checker, signatureEvidence.type, signatureEvidence.declaration);
}

function probeExportSymbol(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.StringLiteralLike | undefined,
  exportName: string,
): ts.Symbol | undefined {
  const moduleSymbol =
    moduleSpecifier === undefined ? undefined : checker.getSymbolAtLocation(moduleSpecifier);
  const exportedSymbol = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === exportName)
    : undefined;
  return exportedSymbol === undefined
    ? undefined
    : exportedSymbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exportedSymbol)
      : exportedSymbol;
}

function probeSignatureEvidence(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): { readonly declaration: ts.Declaration; readonly type: ts.Type } | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined) {
    return undefined;
  }
  const type =
    symbol.flags & ts.SymbolFlags.Value
      ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
      : checker.getDeclaredTypeOfSymbol(symbol);
  return { declaration, type };
}

function probeTypeSignatures(
  checker: ts.TypeChecker,
  type: ts.Type,
  declaration: ts.Declaration,
): readonly ProbeSignature[] {
  return [
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((signature) => ({
      kind: "call" as const,
      text: probeSignatureText(checker, signature, declaration, ts.SignatureKind.Call),
    })),
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct).map((signature) => ({
      kind: "construct" as const,
      text: probeSignatureText(checker, signature, declaration, ts.SignatureKind.Construct),
    })),
  ];
}

function probeSignatureText(
  checker: ts.TypeChecker,
  signature: ts.Signature,
  declaration: ts.Declaration,
  kind: ts.SignatureKind,
): string {
  return checker.signatureToString(
    signature,
    signature.getDeclaration() ?? declaration,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
      ts.TypeFormatFlags.NoTypeReduction |
      ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
    kind,
  );
}

function findModuleSpecifier(
  sourceFile: ts.SourceFile,
  specifier: string,
): ts.StringLiteralLike | undefined {
  let match: ts.StringLiteralLike | undefined;
  const visit = (node: ts.Node): void => {
    const candidate = moduleSpecifierLiteral(node);
    if (candidate?.text === specifier) {
      match = candidate;
      return;
    }
    if (match === undefined) {
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return match;
}

function moduleSpecifierLiteral(node: ts.Node): ts.StringLiteralLike | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  return ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
    ? node.moduleReference.expression
    : undefined;
}

async function corpusDependencyNames(): Promise<readonly string[]> {
  const dependencies = (await readManifest(CORPUS_MANIFEST))["dependencies"];
  if (!isRecord(dependencies)) {
    throw new Error(`Corpus manifest ${CORPUS_MANIFEST} has no dependencies.`);
  }
  return Object.keys(dependencies).sort();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageVersion(manifest: unknown, manifestPath: string): string {
  const version = isRecord(manifest) ? manifest["version"] : undefined;
  if (typeof version !== "string") {
    throw new Error(`Package manifest ${manifestPath} has no version.`);
  }
  return version;
}

async function visiblePackageIdentity(
  resolutionContext: string,
  packageName: string,
): Promise<string> {
  let directory = resolutionContext;
  for (let depth = 0; depth < 64; depth += 1) {
    const manifestPath = join(directory, "node_modules", ...packageName.split("/"), "package.json");
    try {
      const manifest = await readManifest(manifestPath);
      return `${String(manifest["name"])}@${packageVersion(manifest, manifestPath)}`;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error(`Package ${packageName} is not visible from ${resolutionContext}.`);
}

async function readManifest(manifestPath: string): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as Readonly<Record<string, unknown>>;
}
