import ts from "@typescript/typescript6";
import { relative, sep } from "node:path";

import type { ModuleInspection } from "#typepeek/inspection/analyze";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  resolveDeclarationOwner,
  type PackageModuleEvidence,
} from "#typepeek/inspection/package-evidence";
import { isPathWithin } from "#typepeek/inspection/paths";
import type {
  DeclarationKind,
  DeclarationSpace,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportSignature,
  InspectedDeclaration,
  InspectedModuleExport,
  PackageDocumentation,
  SupportingType,
} from "#typepeek/inspection/protocol";

const MAX_DECLARATIONS_PER_SYMBOL = 128;
const MAX_DOCUMENTATION_BYTES = 16 * 1_024;
const MAX_SIGNATURES = 64;
const MAX_SUPPORTING_TYPE_DEPTH = 8;
const MAX_SUPPORTING_TYPES = 48;
const MAX_DECLARATION_BYTES = 64 * 1_024;
const MAX_SIGNATURE_BYTES = 16 * 1_024;
const MAX_SIGNATURE_TOTAL_BYTES = 48 * 1_024;

const DECLARATION_SPACES: readonly DeclarationSpace[] = ["type", "value", "namespace"];
const SYMBOL_FLAGS_BY_SPACE: Readonly<Record<DeclarationSpace, ts.SymbolFlags>> = {
  type: ts.SymbolFlags.Type,
  value: ts.SymbolFlags.Value,
  namespace: ts.SymbolFlags.Namespace,
};
const DECLARATION_SPACES_BY_KIND: Readonly<Record<DeclarationKind, readonly DeclarationSpace[]>> = {
  alias: [],
  class: ["type", "value"],
  enum: ["type", "value"],
  function: ["value"],
  interface: ["type"],
  namespace: ["value", "namespace"],
  "type-alias": ["type"],
  variable: ["value"],
};
const UNSAFE_PRESENTATION_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const ANSI_CONTROL_SEQUENCE_PREFIX = String.fromCodePoint(0x1b, 0x5b);

const DECLARATION_KIND_BY_SYNTAX_KIND = new Map<ts.SyntaxKind, DeclarationKind>([
  [ts.SyntaxKind.ClassDeclaration, "class"],
  [ts.SyntaxKind.EnumDeclaration, "enum"],
  [ts.SyntaxKind.FunctionDeclaration, "function"],
  [ts.SyntaxKind.InterfaceDeclaration, "interface"],
  [ts.SyntaxKind.ModuleDeclaration, "namespace"],
  [ts.SyntaxKind.TypeAliasDeclaration, "type-alias"],
  [ts.SyntaxKind.VariableDeclaration, "variable"],
  [ts.SyntaxKind.ExportAssignment, "alias"],
  [ts.SyntaxKind.ExportSpecifier, "alias"],
  [ts.SyntaxKind.ImportEqualsDeclaration, "alias"],
  [ts.SyntaxKind.NamespaceExport, "alias"],
]);

const declarationPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

interface SignatureCandidate {
  readonly compilerOrder: number;
  readonly kind: ExportSignature["kind"];
  readonly signature: ts.Signature;
  readonly signatureKind: ts.SignatureKind;
}

export function inspectFocusedModuleExport(
  inspection: ModuleInspection,
  evidence: PackageModuleEvidence,
  exportName: string,
  specifier: string,
): ExportInspection | undefined {
  const exportedSymbol = inspection.checker
    .getExportsOfModule(inspection.moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);
  if (exportedSymbol === undefined) {
    return undefined;
  }

  const targetSymbol = resolveExportTarget(inspection.checker, exportedSymbol);
  const packageDocumentation = inspectPackageDocumentation(
    inspection.checker,
    exportedSymbol,
    targetSymbol,
  );
  return {
    intent: "export-inspection",
    specifier,
    packageIdentity: evidence.packageIdentity,
    moduleExport: inspectModuleExport(inspection.checker, evidence, exportedSymbol, targetSymbol),
    supportingTypes: inspectSupportingTypes(inspection.checker, evidence, targetSymbol),
    ...(packageDocumentation === undefined ? {} : { packageDocumentation }),
  };
}

function resolveExportTarget(checker: ts.TypeChecker, exportedSymbol: ts.Symbol): ts.Symbol {
  if ((exportedSymbol.flags & ts.SymbolFlags.Alias) === 0) {
    return exportedSymbol;
  }
  const targetSymbol = checker.getAliasedSymbol(exportedSymbol);
  if (targetSymbol.declarations === undefined || targetSymbol.declarations.length === 0) {
    throw new UnsupportedInspectionError(
      "The selected Module Export alias could not be resolved from Installed Evidence.",
    );
  }
  return targetSymbol;
}

function inspectModuleExport(
  checker: ts.TypeChecker,
  evidence: PackageModuleEvidence,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
): InspectedModuleExport {
  const aliasDeclaration = findAliasDeclaration(exportedSymbol);
  const alias = inspectAlias(evidence, exportedSymbol, aliasDeclaration, targetSymbol);
  const spaces = occupiedDeclarationSpaces(exportedSymbol, targetSymbol, aliasDeclaration);
  return {
    name: exportedSymbol.getName(),
    ...(alias === undefined ? {} : { alias }),
    spaces: inspectDeclarationSpaces(checker, evidence, targetSymbol, spaces, aliasDeclaration),
    signatures: inspectSignatures(checker, targetSymbol, spaces),
  };
}

function inspectAlias(
  evidence: PackageModuleEvidence,
  exportedSymbol: ts.Symbol,
  aliasDeclaration: ts.Declaration | undefined,
  targetSymbol: ts.Symbol,
): ExportAlias | undefined {
  if (
    aliasDeclaration === undefined ||
    (ts.isExportSpecifier(aliasDeclaration) && exportedSymbol.getName() === targetSymbol.getName())
  ) {
    return undefined;
  }
  return {
    targetName: aliasTargetName(aliasDeclaration, targetSymbol),
    declaration: inspectDeclaration(evidence, aliasDeclaration, "alias"),
  };
}

function aliasTargetName(aliasDeclaration: ts.Declaration, targetSymbol: ts.Symbol): string {
  if (!ts.isNamespaceExport(aliasDeclaration)) {
    return targetSymbol.getName();
  }
  const moduleSpecifier = aliasDeclaration.parent.moduleSpecifier;
  return moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)
    ? moduleSpecifier.text
    : "namespace module";
}

function findAliasDeclaration(exportedSymbol: ts.Symbol): ts.Declaration | undefined {
  if ((exportedSymbol.flags & ts.SymbolFlags.Alias) === 0) {
    return undefined;
  }
  const declaration = exportedSymbol.declarations?.find(isAliasDeclaration);
  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export alias has no declaration provenance.",
    );
  }
  return declaration;
}

function occupiedDeclarationSpaces(
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: ts.Declaration | undefined,
): readonly DeclarationSpace[] {
  if (aliasDeclaration !== undefined && isTypeOnlyAlias(aliasDeclaration)) {
    return ["type"];
  }
  const symbol =
    (exportedSymbol.flags & ts.SymbolFlags.Alias) === 0 ? exportedSymbol : targetSymbol;
  return DECLARATION_SPACES.filter((space) => symbolOccupiesSpace(symbol, space));
}

function inspectDeclarationSpaces(
  checker: ts.TypeChecker,
  evidence: PackageModuleEvidence,
  symbol: ts.Symbol,
  occupiedSpaces: readonly DeclarationSpace[],
  aliasDeclaration: ts.Declaration | undefined,
): readonly ExportDeclarationSpace[] {
  const declarations = inspectableDeclarations(symbol);
  const namespaceDeclarations = inspectNamespaceMemberDeclarations(checker, symbol);
  return occupiedSpaces.map((space) =>
    inspectDeclarationSpace(evidence, space, declarations, namespaceDeclarations, aliasDeclaration),
  );
}

function inspectDeclarationSpace(
  evidence: PackageModuleEvidence,
  space: DeclarationSpace,
  declarations: readonly ts.Declaration[],
  namespaceDeclarations: readonly ts.Declaration[],
  aliasDeclaration: ts.Declaration | undefined,
): ExportDeclarationSpace {
  const declarationsInSpace = declarationsForSpace(space, declarations, namespaceDeclarations);
  return {
    space,
    declarations: inspectedDeclarations(evidence, declarationsInSpace, aliasDeclaration),
  };
}

function declarationsForSpace(
  space: DeclarationSpace,
  declarations: readonly ts.Declaration[],
  namespaceDeclarations: readonly ts.Declaration[],
): readonly ts.Declaration[] {
  return space === "namespace" && namespaceDeclarations.length > 0
    ? namespaceDeclarations
    : declarations.filter((declaration) => declarationSpaces(declaration).includes(space));
}

function inspectedDeclarations(
  evidence: PackageModuleEvidence,
  declarations: readonly ts.Declaration[],
  aliasDeclaration: ts.Declaration | undefined,
): readonly InspectedDeclaration[] {
  if (declarations.length > 0) {
    return declarations.map((declaration) => inspectDeclaration(evidence, declaration));
  }
  return aliasDeclaration === undefined
    ? []
    : [inspectDeclaration(evidence, aliasDeclaration, "alias")];
}

function inspectNamespaceMemberDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly ts.Declaration[] {
  return collectNamespaceMemberDeclarations(checker, symbol, new Set(), 0);
}

function collectNamespaceMemberDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  visited: Set<ts.Symbol>,
  depth: number,
): readonly ts.Declaration[] {
  if ((symbol.flags & ts.SymbolFlags.Module) === 0) {
    return [];
  }
  if (depth > MAX_SUPPORTING_TYPE_DEPTH) {
    throw new InspectionLimitError("Inspection exceeded its namespace traversal depth limit.");
  }
  if (visited.has(symbol)) {
    throw new UnsupportedInspectionError(
      "The selected Module Export contains a circular namespace re-export.",
    );
  }
  visited.add(symbol);
  const declarations = checker
    .getExportsOfModule(symbol)
    .flatMap((member) => inspectNamespaceMember(checker, member, visited, depth));
  assertDeclarationLimit(declarations);
  visited.delete(symbol);
  return declarations;
}

function inspectNamespaceMember(
  checker: ts.TypeChecker,
  member: ts.Symbol,
  visited: Set<ts.Symbol>,
  depth: number,
): readonly ts.Declaration[] {
  const aliasDeclaration = findAliasDeclaration(member);
  const target = resolveExportTarget(checker, member);
  const namespaceAliasDeclaration =
    aliasDeclaration !== undefined && ts.isNamespaceExport(aliasDeclaration)
      ? [aliasDeclaration]
      : [];
  return [
    ...namespaceAliasDeclaration,
    ...inspectableDeclarations(target),
    ...collectNamespaceMemberDeclarations(checker, target, visited, depth + 1),
  ];
}

function symbolOccupiesSpace(symbol: ts.Symbol, space: DeclarationSpace): boolean {
  return (symbol.flags & SYMBOL_FLAGS_BY_SPACE[space]) !== 0;
}

function declarationSpaces(declaration: ts.Declaration): readonly DeclarationSpace[] {
  const kind = declarationKind(declaration);
  return kind === undefined ? [] : DECLARATION_SPACES_BY_KIND[kind];
}

function inspectSignatures(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  spaces: readonly DeclarationSpace[],
): readonly ExportSignature[] {
  const declaration = signatureDeclaration(symbol);
  if (declaration === undefined) {
    return [];
  }
  const type = signatureType(checker, symbol, declaration, spaces);
  const candidates = [
    ...signatureCandidates(checker, type, ts.SignatureKind.Call, "call"),
    ...signatureCandidates(checker, type, ts.SignatureKind.Construct, "construct"),
  ];
  const sourceOrder = declarationSourceOrder(symbol, type);
  candidates.sort((left, right) => compareSignatureCandidates(left, right, sourceOrder));
  if (candidates.length > MAX_SIGNATURES) {
    throw new InspectionLimitError("Inspection exceeded its Module Export signature limit.");
  }

  let totalBytes = 0;
  return candidates.map(({ kind, signature, signatureKind }) => {
    const text = checker.signatureToString(
      signature,
      declaration,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
      signatureKind,
    );
    const signatureBytes = Buffer.byteLength(text);
    totalBytes += signatureBytes;
    if (signatureBytes > MAX_SIGNATURE_BYTES || totalBytes > MAX_SIGNATURE_TOTAL_BYTES) {
      throw new InspectionLimitError("Inspection exceeded its Module Export signature byte limit.");
    }
    return { kind, text };
  });
}

function signatureDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function signatureType(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  spaces: readonly DeclarationSpace[],
): ts.Type {
  return spaces.includes("value")
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : checker.getDeclaredTypeOfSymbol(symbol);
}

function signatureCandidates(
  checker: ts.TypeChecker,
  type: ts.Type,
  signatureKind: ts.SignatureKind,
  kind: ExportSignature["kind"],
): readonly SignatureCandidate[] {
  return checker.getSignaturesOfType(type, signatureKind).map((signature, compilerOrder) => ({
    compilerOrder,
    kind,
    signature,
    signatureKind,
  }));
}

function declarationSourceOrder(symbol: ts.Symbol, type: ts.Type): ReadonlyMap<string, number> {
  const declarations = [...symbolDeclarations(symbol), ...symbolDeclarations(type.symbol)];
  const sources = declarations.map((declaration) => declaration.getSourceFile().fileName);
  return new Map(Array.from(new Set(sources), (source, index) => [source, index]));
}

function symbolDeclarations(symbol: ts.Symbol | undefined): readonly ts.Declaration[] {
  return symbol?.declarations ?? [];
}

function compareSignatureCandidates(
  left: SignatureCandidate,
  right: SignatureCandidate,
  sourceOrder: ReadonlyMap<string, number>,
): number {
  const leftDeclaration = left.signature.getDeclaration();
  const rightDeclaration = right.signature.getDeclaration();
  const sameSourceOrder = comparePositionsInSameSource(leftDeclaration, rightDeclaration);
  if (sameSourceOrder !== undefined) {
    return sameSourceOrder;
  }
  const sourceDifference =
    sourceRank(sourceOrder, leftDeclaration) - sourceRank(sourceOrder, rightDeclaration);
  return sourceDifference === 0 ? left.compilerOrder - right.compilerOrder : sourceDifference;
}

function comparePositionsInSameSource(
  left: ts.SignatureDeclaration,
  right: ts.SignatureDeclaration,
): number | undefined {
  return left.getSourceFile() === right.getSourceFile()
    ? left.getStart() - right.getStart()
    : undefined;
}

function sourceRank(
  sourceOrder: ReadonlyMap<string, number>,
  declaration: ts.SignatureDeclaration,
): number {
  return sourceOrder.get(declaration.getSourceFile().fileName) ?? Number.MAX_SAFE_INTEGER;
}

function inspectSupportingTypes(
  checker: ts.TypeChecker,
  evidence: PackageModuleEvidence,
  selectedSymbol: ts.Symbol,
): readonly SupportingType[] {
  const supportingTypes: SupportingType[] = [];
  const visited = new Set<ts.Symbol>([selectedSymbol]);

  const inspectReference = (location: ts.Node, depth: number): void => {
    const symbol = referencedSupportingType(checker, location, visited);
    if (symbol === undefined) {
      return;
    }
    assertSupportingTypeBudget(depth, supportingTypes.length);
    visited.add(symbol);

    const declarations = supportingTypeDeclarations(symbol);
    supportingTypes.push({
      name: symbol.getName(),
      declarations: declarations.map((declaration) => inspectDeclaration(evidence, declaration)),
    });
    for (const declaration of declarations) {
      visitTypeReferences(declaration, (reference) => inspectReference(reference, depth + 1));
    }
  };

  for (const declaration of supportingRootDeclarations(checker, selectedSymbol)) {
    visitTypeReferences(declaration, (reference) => inspectReference(reference, 1));
  }
  return supportingTypes;
}

function supportingRootDeclarations(
  checker: ts.TypeChecker,
  selectedSymbol: ts.Symbol,
): readonly ts.Declaration[] {
  return [
    ...inspectableDeclarations(selectedSymbol),
    ...inspectNamespaceMemberDeclarations(checker, selectedSymbol),
  ];
}

function referencedSupportingType(
  checker: ts.TypeChecker,
  location: ts.Node,
  visited: ReadonlySet<ts.Symbol>,
): ts.Symbol | undefined {
  const referenced = checker.getSymbolAtLocation(location);
  if (referenced === undefined) {
    return undefined;
  }
  const symbol = resolveExportTarget(checker, referenced);
  return visited.has(symbol) || !isSupportingTypeSymbol(symbol) ? undefined : symbol;
}

function assertSupportingTypeBudget(depth: number, supportingTypeCount: number): void {
  if (depth > MAX_SUPPORTING_TYPE_DEPTH) {
    throw new InspectionLimitError("Inspection exceeded its Supporting Type depth limit.");
  }
  if (supportingTypeCount >= MAX_SUPPORTING_TYPES) {
    throw new InspectionLimitError("Inspection exceeded its Supporting Type limit.");
  }
}

function visitTypeReferences(node: ts.Node, visitReference: (location: ts.Node) => void): void {
  if (isPrivateDeclaration(node)) {
    return;
  }
  const location = typeReferenceLocation(node);
  if (location !== undefined) {
    visitReference(location);
  }
  ts.forEachChild(node, (child) => visitTypeReferences(child, visitReference));
}

function isPrivateDeclaration(node: ts.Node): boolean {
  return hasPrivateIdentifier(node) || hasPrivateModifier(node);
}

function hasPrivateIdentifier(node: ts.Node): boolean {
  const name = "name" in node ? (node.name as ts.Node | undefined) : undefined;
  return name === undefined ? false : ts.isPrivateIdentifier(name);
}

function hasPrivateModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword);
}

function isSupportingTypeSymbol(symbol: ts.Symbol): boolean {
  return supportingTypeDeclarations(symbol).length > 0;
}

function supportingTypeDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const declarations = (symbol.declarations ?? []).filter(
    (declaration) =>
      ts.isClassDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration),
  );
  assertDeclarationLimit(declarations);
  return declarations;
}

function inspectableDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const declarations = (symbol.declarations ?? []).filter(
    (declaration) => declarationKind(declaration) !== undefined,
  );
  assertDeclarationLimit(declarations);
  return declarations;
}

function assertDeclarationLimit(declarations: readonly ts.Declaration[]): void {
  if (declarations.length > MAX_DECLARATIONS_PER_SYMBOL) {
    throw new InspectionLimitError("Inspection exceeded its declaration merge limit.");
  }
}

function inspectDeclaration(
  evidence: PackageModuleEvidence,
  declaration: ts.Declaration,
  kindOverride?: DeclarationKind,
): InspectedDeclaration {
  const sourceFile = declaration.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile, false));
  const text = renderDeclaration(declaration, sourceFile);
  if (Buffer.byteLength(text) > MAX_DECLARATION_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its declaration output limit.");
  }
  const kind = inspectedDeclarationKind(declaration, kindOverride);
  const owner = declarationOwner(evidence, sourceFile.fileName);
  return {
    kind,
    text,
    provenance: {
      packageIdentity: owner.packageIdentity,
      file: relative(owner.packageRoot, sourceFile.fileName).split(sep).join("/"),
      line: start.line + 1,
      column: start.character + 1,
    },
  };
}

function inspectedDeclarationKind(
  declaration: ts.Declaration,
  kindOverride: DeclarationKind | undefined,
): DeclarationKind {
  const kind = kindOverride ?? declarationKind(declaration);
  if (kind === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export contains an unsupported declaration kind.",
    );
  }
  return kind;
}

function declarationOwner(
  evidence: PackageModuleEvidence,
  declarationPath: string,
): PackageModuleEvidence | ReturnType<typeof resolveDeclarationOwner> {
  return isPathWithin(evidence.packageRoot, declarationPath)
    ? evidence
    : resolveDeclarationOwner(declarationPath);
}

function renderDeclaration(declaration: ts.Declaration, sourceFile: ts.SourceFile): string {
  const printableDeclaration = ts.isNamespaceExport(declaration) ? declaration.parent : declaration;
  return declarationPrinter
    .printNode(ts.EmitHint.Unspecified, publicDeclaration(printableDeclaration), sourceFile)
    .trim()
    .replace(/^(?:export\s+)?(?:declare\s+)?/u, "");
}

function publicDeclaration(declaration: ts.Declaration): ts.Declaration {
  return ts.isClassDeclaration(declaration)
    ? ts.factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        declaration.heritageClauses,
        declaration.members.filter((member) => !isPrivateDeclaration(member)),
      )
    : declaration;
}

function declarationKind(declaration: ts.Declaration): DeclarationKind | undefined {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind);
}

function isAliasDeclaration(
  declaration: ts.Declaration,
): declaration is
  | ts.ExportAssignment
  | ts.ExportSpecifier
  | ts.ImportEqualsDeclaration
  | ts.NamespaceExport {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind) === "alias";
}

function isTypeOnlyAlias(declaration: ts.Declaration): boolean {
  return (
    typeOnlyExportSpecifier(declaration) ??
    typeOnlyNamespaceExport(declaration) ??
    typeOnlyImportEqualsDeclaration(declaration) ??
    false
  );
}

function typeReferenceLocation(node: ts.Node): ts.Node | undefined {
  return (
    typeReferenceName(node) ??
    expressionWithTypeArgumentsName(node) ??
    typeQueryName(node) ??
    importTypeName(node)
  );
}

function typeReferenceName(node: ts.Node): ts.Node | undefined {
  return ts.isTypeReferenceNode(node) ? node.typeName : undefined;
}

function expressionWithTypeArgumentsName(node: ts.Node): ts.Node | undefined {
  return ts.isExpressionWithTypeArguments(node) ? node.expression : undefined;
}

function typeQueryName(node: ts.Node): ts.Node | undefined {
  return ts.isTypeQueryNode(node) ? node.exprName : undefined;
}

function importTypeName(node: ts.Node): ts.Node | undefined {
  return ts.isImportTypeNode(node) ? node.qualifier : undefined;
}

function typeOnlyExportSpecifier(declaration: ts.Declaration): boolean | undefined {
  return ts.isExportSpecifier(declaration)
    ? declaration.isTypeOnly || declaration.parent.parent.isTypeOnly
    : undefined;
}

function typeOnlyNamespaceExport(declaration: ts.Declaration): boolean | undefined {
  return ts.isNamespaceExport(declaration) ? declaration.parent.isTypeOnly : undefined;
}

function typeOnlyImportEqualsDeclaration(declaration: ts.Declaration): boolean | undefined {
  return ts.isImportEqualsDeclaration(declaration) ? declaration.isTypeOnly : undefined;
}

function inspectPackageDocumentation(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
): PackageDocumentation | undefined {
  const documentation = sanitizePackageDocumentation(
    packageDocumentationText(checker, exportedSymbol, targetSymbol),
  );
  if (documentation.length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(documentation) > MAX_DOCUMENTATION_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its Package Documentation limit.");
  }
  return {
    provenance: "installed-evidence",
    trust: "untrusted",
    text: documentation,
  };
}

function packageDocumentationText(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
): string {
  return (
    [
      aliasDocumentation(exportedSymbol),
      symbolDocumentation(exportedSymbol, checker),
      symbolDocumentation(targetSymbol, checker),
    ].find((documentation) => documentation.length > 0) ?? ""
  );
}

function symbolDocumentation(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  return [
    ts.displayPartsToString(symbol.getDocumentationComment(checker)),
    ...symbol.getJsDocTags(checker).map(renderJsDocTag),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function renderJsDocTag(tag: ts.JSDocTagInfo): string {
  const text = tag.text === undefined ? "" : ` ${ts.displayPartsToString(tag.text)}`;
  return `@${tag.name}${text}`;
}

function aliasDocumentation(exportedSymbol: ts.Symbol): string {
  const aliasDeclaration = findAliasDeclaration(exportedSymbol);
  if (aliasDeclaration === undefined) {
    return "";
  }
  const host = ts.isExportSpecifier(aliasDeclaration)
    ? aliasDeclaration.parent.parent
    : ts.isNamespaceExport(aliasDeclaration)
      ? aliasDeclaration.parent
      : aliasDeclaration;
  return ts
    .getJSDocCommentsAndTags(host)
    .flatMap(jsDocNodeText)
    .filter((comment) => comment.length > 0)
    .join("\n");
}

function jsDocNodeText(node: ts.JSDoc | ts.JSDocTag): readonly string[] {
  if (ts.isJSDoc(node)) {
    return [
      ts.getTextOfJSDocComment(node.comment) ?? "",
      ...(node.tags?.map((tag) => renderJsDocNodeTag(tag)) ?? []),
    ];
  }
  return [renderJsDocNodeTag(node)];
}

function renderJsDocNodeTag(tag: ts.JSDocTag): string {
  const comment = ts.getTextOfJSDocComment(tag.comment);
  return `@${tag.tagName.text}${comment === undefined ? "" : ` ${comment}`}`;
}

function sanitizePackageDocumentation(documentation: string): string {
  return stripUnsafePresentationCharacters(
    documentation.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  ).trim();
}

function stripUnsafePresentationCharacters(value: string): string {
  return Array.from(stripAnsiControlSequences(value))
    .filter((character) => !isUnsafePresentationCharacter(character.codePointAt(0) ?? 0))
    .join("");
}

function stripAnsiControlSequences(value: string): string {
  let remainder = value;
  let sanitized = "";
  while (true) {
    const sequenceStart = remainder.indexOf(ANSI_CONTROL_SEQUENCE_PREFIX);
    if (sequenceStart < 0) {
      return sanitized + remainder;
    }
    sanitized += remainder.slice(0, sequenceStart);
    const sequenceEnd = ansiControlSequenceEnd(
      remainder,
      sequenceStart + ANSI_CONTROL_SEQUENCE_PREFIX.length,
    );
    remainder = sequenceEnd === undefined ? "" : remainder.slice(sequenceEnd + 1);
  }
}

function ansiControlSequenceEnd(value: string, start: number): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    if (isAnsiFinalByte(value.charCodeAt(index))) {
      return index;
    }
  }
  return undefined;
}

function isAnsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function isUnsafePresentationCharacter(codePoint: number): boolean {
  return UNSAFE_PRESENTATION_RANGES.some(
    ([rangeStart, rangeEnd]) => codePoint >= rangeStart && codePoint <= rangeEnd,
  );
}
