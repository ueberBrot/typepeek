import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Predicate, Schema } from "effect";
import {
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteralLikeNode,
  ScriptTarget,
} from "tsrs/ast";
import type {
  Declaration,
  Node,
  SourceFile,
  StringLiteralLikeNode,
} from "tsrs/ast";
import {
  ModuleKind,
  ModuleResolutionKind,
  SignatureKind,
  SymbolFlags,
} from "tsrs/sync";
import type {
  Checker,
  Program,
  RawCompilerOptions,
  Signature,
  Symbol as CompilerSymbol,
  Type,
} from "tsrs/sync";

import {
  declarationsOf,
  valueDeclarationOf,
  signatureText,
} from "#typepeek/inspection/compiler/compiler-session";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";
import {
  decodeJson,
  isJsonObject,
  mutableJsonObjectSchema,
} from "#typepeek/shared/json-data";

import { createFixtureProgram } from "./native-compiler.ts";
import { installLockedPackagesWithNpm } from "./package-toolchain.ts";

const PACKAGE_MANIFEST_FILE = "package.json";

const CORPUS_WORKSPACE = nodePath.join(
  process.cwd(),
  "tests",
  "fixtures",
  "real-package-corpus"
);

const CORPUS_MANIFEST = nodePath.join(CORPUS_WORKSPACE, PACKAGE_MANIFEST_FILE);
const CORPUS_LOCKFILE = nodePath.join(CORPUS_WORKSPACE, "package-lock.json");

const CORPUS_LEGACY_MANIFEST = nodePath.join(
  CORPUS_WORKSPACE,
  "workspaces",
  "legacy",
  PACKAGE_MANIFEST_FILE
);

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
    context?: "legacy" | "root"
  ) => Promise<string>;
  readonly packageNames: readonly string[];
  readonly packageIdentity: (
    packageName: string,
    resolutionContext?: string
  ) => Promise<string>;
  readonly resolutionContext: string;
}

export interface ProbeSignature {
  readonly kind: "call" | "construct";
  readonly text: string;
}

const readManifest = async function readManifest(
  manifestPath: string
): Promise<Schema.JsonObject> {
  return decodeJson(
    mutableJsonObjectSchema,
    await readFile(manifestPath, "utf-8")
  );
};

const corpusDependencyNames = async function corpusDependencyNames(): Promise<
  readonly string[]
> {
  const { dependencies } = await readManifest(CORPUS_MANIFEST);

  if (!Predicate.isReadonlyObject(dependencies)) {
    throw new Error(`Corpus manifest ${CORPUS_MANIFEST} has no dependencies.`);
  }

  return Object.keys(dependencies).toSorted();
};

const moduleSpecifierLiteral = function moduleSpecifierLiteral(
  node: Node
): StringLiteralLikeNode | undefined {
  if (
    (isImportDeclaration(node) || isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    isStringLiteralLikeNode(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }

  if (
    !isImportEqualsDeclaration(node) ||
    !isExternalModuleReference(node.moduleReference)
  ) {
    return undefined;
  }

  const { expression } = node.moduleReference;

  return expression !== undefined && isStringLiteralLikeNode(expression)
    ? expression
    : undefined;
};

const findModuleSpecifier = function findModuleSpecifier(
  sourceFile: SourceFile,
  specifier: string
): StringLiteralLikeNode | undefined {
  let match: StringLiteralLikeNode | undefined;

  const visit = (node: Node): void => {
    const candidate = moduleSpecifierLiteral(node);

    if (candidate?.text === specifier) {
      match = candidate;

      return;
    }

    if (match === undefined) {
      node.forEachChild(visit);
    }
  };

  visit(sourceFile);

  return match;
};

const probeExportSymbol = function probeExportSymbol(
  checker: Checker,
  moduleSpecifier: StringLiteralLikeNode | undefined,
  exportName: string
): CompilerSymbol | undefined {
  const moduleSymbol =
    moduleSpecifier === undefined
      ? undefined
      : checker.getSymbolAtLocation(moduleSpecifier);

  const exportedSymbol = moduleSymbol
    ? checker
        .getExportsOfModule(moduleSymbol)
        .find(({ name }) => name === exportName)
    : undefined;

  if (exportedSymbol === undefined) {
    return undefined;
  }

  if (bitwiseAnd(exportedSymbol.flags, SymbolFlags.Alias)) {
    return checker.getAliasedSymbol(exportedSymbol);
  }

  return exportedSymbol;
};

const probeSignatureEvidence = function probeSignatureEvidence(
  checker: Checker,
  symbol: CompilerSymbol
):
  | {
      readonly declaration: Declaration;
      readonly type: Type;
    }
  | undefined {
  const declaration = valueDeclarationOf(symbol) ?? declarationsOf(symbol)[0];

  if (declaration === undefined) {
    return undefined;
  }

  const type = bitwiseAnd(symbol.flags, SymbolFlags.Value)
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : checker.getDeclaredTypeOfSymbol(symbol);

  return { declaration, type };
};

const probeSignatureText = function probeSignatureText(
  checker: Checker,
  signature: Signature,
  declaration: Declaration,
  kind: SignatureKind
): string {
  return signatureText(
    checker,
    signature,
    signature.declaration?.resolve() ?? declaration,
    kind
  );
};

const probeTypeSignatures = function probeTypeSignatures(
  checker: Checker,
  type: Type,
  declaration: Declaration
): readonly ProbeSignature[] {
  return [
    ...checker
      .getSignaturesOfType(type, SignatureKind.Call)
      .map((signature) => ({
        kind: "call" as const,
        text: probeSignatureText(
          checker,
          signature,
          declaration,
          SignatureKind.Call
        ),
      })),
    ...checker
      .getSignaturesOfType(type, SignatureKind.Construct)
      .map((signature) => ({
        kind: "construct" as const,
        text: probeSignatureText(
          checker,
          signature,
          declaration,
          SignatureKind.Construct
        ),
      })),
  ];
};

const probeExportSignatures = function probeExportSignatures(
  program: Program,
  checker: Checker,
  probePath: string,
  specifier: string,
  exportName: string
): readonly ProbeSignature[] {
  const sourceFile = program.getSourceFile(probePath);

  const moduleSpecifier =
    sourceFile === undefined
      ? undefined
      : findModuleSpecifier(sourceFile, specifier);

  const symbol = probeExportSymbol(checker, moduleSpecifier, exportName);

  const signatureEvidence =
    symbol === undefined ? undefined : probeSignatureEvidence(checker, symbol);

  if (signatureEvidence === undefined) {
    return [];
  }

  return probeTypeSignatures(
    checker,
    signatureEvidence.type,
    signatureEvidence.declaration
  );
};

const packageVersion = function packageVersion(
  manifest: Schema.Json | undefined,
  manifestPath: string
): string {
  const version = Predicate.isReadonlyObject(manifest)
    ? manifest["version"]
    : undefined;

  if (!Predicate.isString(version)) {
    throw new TypeError(`Package manifest ${manifestPath} has no version.`);
  }

  return version;
};

const lockedPackageIdentity = async function lockedPackageIdentity(
  packageName: string,
  context: "legacy" | "root"
): Promise<string> {
  const { packages } = await readManifest(CORPUS_LOCKFILE);

  if (!isJsonObject(packages)) {
    throw new Error(
      `Corpus lockfile ${CORPUS_LOCKFILE} has no packages index.`
    );
  }

  const packagePath =
    context === "legacy"
      ? `workspaces/legacy/node_modules/${packageName}`
      : `node_modules/${packageName}`;

  return `${packageName}@${packageVersion(packages[packagePath], packagePath)}`;
};

const visiblePackageIdentity = async function visiblePackageIdentity(
  resolutionContext: string,
  packageName: string
): Promise<string> {
  let directory = resolutionContext;

  for (let depth = 0; depth < 64; depth += 1) {
    const manifestPath = nodePath.join(
      directory,
      "node_modules",
      ...packageName.split("/"),
      PACKAGE_MANIFEST_FILE
    );

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Resolve the nearest installed ancestor before reading its parent.
      const manifest = await readManifest(manifestPath);

      return `${Schema.decodeUnknownSync(Schema.String)(manifest["name"])}@${packageVersion(manifest, manifestPath)}`;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    const parent = nodePath.dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  throw new Error(
    `Package ${packageName} is not visible from ${resolutionContext}.`
  );
};

export const materializeRealPackageCorpus =
  async function materializeRealPackageCorpus(): Promise<RealPackageCorpus> {
    const packageNames = await corpusDependencyNames();

    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-real-corpus-")
    );

    const resolutionContext = nodePath.join(fixtureRoot, "consumer");

    const legacyWorkspaceContext = nodePath.join(
      resolutionContext,
      "workspaces",
      "legacy"
    );

    try {
      await mkdir(legacyWorkspaceContext, { recursive: true });
      await Promise.all([
        copyFile(
          CORPUS_MANIFEST,
          nodePath.join(resolutionContext, PACKAGE_MANIFEST_FILE)
        ),
        copyFile(
          CORPUS_LOCKFILE,
          nodePath.join(resolutionContext, "package-lock.json")
        ),
        copyFile(
          CORPUS_LEGACY_MANIFEST,
          nodePath.join(legacyWorkspaceContext, PACKAGE_MANIFEST_FILE)
        ),
      ]);
      await installLockedPackagesWithNpm({
        cacheRoot: fixtureRoot,
        diagnosticContext: `real-package corpus Resolution Context ${resolutionContext}`,
        resolutionContext,
      });
    } catch (error) {
      await rm(fixtureRoot, { force: true, recursive: true });
      throw error;
    }

    let probeIndex = 0;

    return {
      cleanup: async () => {
        await rm(fixtureRoot, { force: true, recursive: true });
      },
      compileProbe: async ({
        accessStyle = "import",
        resolutionContext: context,
        source,
        specifier,
        exportName,
      }) => {
        const probeContext = context ?? resolutionContext;
        const extension = accessStyle === "import" ? "mts" : "cts";

        const probePath = nodePath.join(
          probeContext,
          `.typepeek-probe-${probeIndex}.${extension}`
        );

        probeIndex += 1;
        await writeFile(probePath, source);

        const options: RawCompilerOptions = {
          module: ModuleKind.NodeNext,
          moduleResolution: ModuleResolutionKind.NodeNext,
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: ScriptTarget.ES2024,
          typeRoots: [
            ...new Set([
              nodePath.join(probeContext, "node_modules", "@types"),
              nodePath.join(resolutionContext, "node_modules", "@types"),
            ]),
          ],
          types: ["node"],
        };

        const program = createFixtureProgram([probePath], options);
        const { checker } = program.getProject();

        const resolution = program.getResolvedModule(
          probePath,
          specifier,
          accessStyle === "require" ? ModuleKind.CommonJS : ModuleKind.ESNext
        );

        return {
          diagnostics: [
            ...program.getProgramDiagnostics(),
            ...program.getSyntacticDiagnostics(),
            ...program.getSemanticDiagnostics(),
          ].map((diagnostic) => diagnostic.text),
          packageIdentity:
            resolution?.packageId === undefined
              ? undefined
              : `${resolution.packageId.name}@${resolution.packageId.version}`,
          signatures:
            exportName === undefined
              ? []
              : probeExportSignatures(
                  program,
                  checker,
                  probePath,
                  specifier,
                  exportName
                ),
        };
      },
      legacyWorkspaceContext,
      lockedPackageIdentity: async (packageName, context = "root") =>
        await lockedPackageIdentity(packageName, context),
      packageIdentity: async (packageName, context = resolutionContext) =>
        await visiblePackageIdentity(context, packageName),
      packageNames,
      resolutionContext,
    };
  };
