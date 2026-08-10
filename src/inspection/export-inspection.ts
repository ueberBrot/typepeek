import ts from "@typescript/typescript6";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import type { InstalledPackageModule } from "#typepeek/inspection/installed-evidence";
import { inspectPackageDocumentation } from "#typepeek/inspection/package-documentation";
import type {
  DeclarationKind,
  DeclarationSpace,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  ExportSignature,
  InspectedDeclaration,
  InspectedModuleExport,
  SupportingType,
} from "#typepeek/inspection/protocol";
import {
  inferredPublicTypes,
  inferredPublicTypeChildren,
  isPrivateDeclaration,
  publicDeclarationSyntax,
  publicDeclarations,
  renderPublicDeclaration,
} from "#typepeek/inspection/public-declaration-rendering";

const MAX_DECLARATIONS_PER_SYMBOL = 128;
const MAX_DECLARATION_BYTES = 64 * 1_024;
const MAX_NAMESPACE_MEMBERS = 128;
const MAX_SIGNATURES = 64;
const MAX_SUPPORTING_TYPE_DEPTH = 8;
const MAX_SUPPORTING_TYPES = 48;
const MAX_SIGNATURE_BYTES = 16 * 1_024;
const MAX_SIGNATURE_TOTAL_BYTES = 48 * 1_024;

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

type AliasDeclaration =
  | ts.ExportAssignment
  | ts.ExportSpecifier
  | ts.ImportEqualsDeclaration
  | ts.NamespaceExport;

interface SignatureCandidate {
  readonly compilerOrder: number;
  readonly kind: ExportSignature["kind"];
  readonly signature: ts.Signature;
  readonly signatureKind: ts.SignatureKind;
}

interface NamespaceMemberEvidence {
  readonly name: string;
  readonly declarations: readonly ts.Declaration[];
  readonly members: readonly NamespaceMemberEvidence[];
}

interface NamespaceTraversalState {
  memberCount: number;
  readonly visited: Set<ts.Symbol>;
}

type SupportingReferenceKind = "type" | "type-query";

interface SupportingReference {
  readonly kind: SupportingReferenceKind;
  readonly location: ts.Node;
}

function inspectDeclaration(
  evidence: InstalledPackageModule,
  declaration: ts.Declaration,
  kindOverride: "alias",
): InspectedDeclaration & { readonly kind: "alias" };
function inspectDeclaration(
  evidence: InstalledPackageModule,
  declaration: ts.Declaration,
  kindOverride?: DeclarationKind,
): InspectedDeclaration;
function inspectDeclaration(
  evidence: InstalledPackageModule,
  declaration: ts.Declaration,
  kindOverride?: DeclarationKind,
): InspectedDeclaration {
  const sourceFile = declaration.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile, false));
  const text = renderPublicDeclaration(evidence.checker, declaration);
  if (Buffer.byteLength(text) > MAX_DECLARATION_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its declaration output limit.");
  }
  const kind = inspectedDeclarationKind(declaration, kindOverride);
  const provenance = evidence.declarationProvenance(sourceFile.fileName);
  return {
    kind,
    text,
    provenance: {
      ...provenance,
      line: start.line + 1,
      column: start.character + 1,
    },
  };
}

function inspectableDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const declarations = publicDeclarations(symbol.declarations ?? []).filter(
    (declaration) => declarationKind(declaration) !== undefined,
  );
  assertDeclarationLimit(declarations);
  return declarations;
}

function assertSupportedSelectedDeclarationKind(
  symbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
): void {
  const declarations = publicDeclarations(symbol.declarations ?? []);
  if (selectedDeclarationIsUnsupported(declarations, aliasDeclaration)) {
    throw new UnsupportedInspectionError(
      "The selected Module Export contains an unsupported declaration kind.",
    );
  }
}

function selectedDeclarationIsUnsupported(
  declarations: readonly ts.Declaration[],
  aliasDeclaration: AliasDeclaration | undefined,
): boolean {
  if (
    declarations.length === 0 ||
    declarations.some((item) => declarationKind(item) !== undefined)
  ) {
    return false;
  }
  if (aliasDeclaration === undefined) {
    return true;
  }
  return declarations.some(ts.isBindingElement);
}

function assertDeclarationLimit(declarations: readonly ts.Declaration[]): void {
  if (declarations.length > MAX_DECLARATIONS_PER_SYMBOL) {
    throw new InspectionLimitError("Inspection exceeded its declaration merge limit.");
  }
}

function declarationKind(declaration: ts.Declaration): DeclarationKind | undefined {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind);
}

function isAliasDeclaration(declaration: ts.Declaration): declaration is AliasDeclaration {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind) === "alias";
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

/**
 * Produces a bounded Export Inspection from one Package Module backed by
 * Installed Evidence. Returns `undefined` only when the named Module Export is
 * absent; unsupported declaration shapes and exhausted budgets use typed errors.
 */
export function inspectFocusedModuleExport(
  evidence: InstalledPackageModule,
  exportName: string,
  specifier: string,
): ExportInspection | undefined {
  const exportedSymbol = evidence.checker
    .getExportsOfModule(evidence.moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);
  if (exportedSymbol === undefined) {
    return undefined;
  }

  const targetSymbol = resolveExportTarget(evidence.checker, exportedSymbol);
  const aliasDeclaration = findAliasDeclaration(exportedSymbol);
  assertSupportedSelectedDeclarationKind(targetSymbol, aliasDeclaration);
  const spaces = occupiedDeclarationSpaces(exportedSymbol, targetSymbol, aliasDeclaration);
  const namespaceMembers = spaces.includes("namespace")
    ? inspectNamespaceMemberEvidence(evidence.checker, targetSymbol)
    : [];
  const packageDocumentation = inspectPackageDocumentation(
    evidence.checker,
    exportedSymbol,
    targetSymbol,
    aliasDeclaration,
  );
  return {
    intent: "export-inspection",
    specifier,
    packageIdentity: evidence.packageIdentity,
    moduleExport: inspectModuleExport(
      evidence,
      exportedSymbol,
      targetSymbol,
      aliasDeclaration,
      spaces,
      namespaceMembers,
    ),
    supportingTypes: inspectSupportingTypes(evidence, targetSymbol, namespaceMembers),
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
  evidence: InstalledPackageModule,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
  spaces: readonly DeclarationSpace[],
  namespaceMembers: readonly NamespaceMemberEvidence[],
): InspectedModuleExport {
  const alias = inspectAlias(evidence, exportedSymbol, aliasDeclaration, targetSymbol);
  return {
    name: exportedSymbol.getName(),
    ...(alias === undefined ? {} : { alias }),
    spaces: inspectDeclarationSpaces(
      evidence,
      targetSymbol,
      spaces,
      aliasDeclaration,
      namespaceMembers,
    ),
    signatures: inspectSignatures(evidence.checker, targetSymbol, spaces),
  };
}

function inspectAlias(
  evidence: InstalledPackageModule,
  exportedSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
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

function aliasTargetName(aliasDeclaration: AliasDeclaration, targetSymbol: ts.Symbol): string {
  if (!ts.isNamespaceExport(aliasDeclaration)) {
    return targetSymbol.getName();
  }
  const moduleSpecifier = aliasDeclaration.parent.moduleSpecifier;
  return moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)
    ? moduleSpecifier.text
    : "namespace module";
}

function findAliasDeclaration(exportedSymbol: ts.Symbol): AliasDeclaration | undefined {
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
  aliasDeclaration: AliasDeclaration | undefined,
): readonly DeclarationSpace[] {
  if (aliasDeclaration !== undefined && isTypeOnlyAlias(aliasDeclaration)) {
    return ["type"];
  }
  const symbol =
    (exportedSymbol.flags & ts.SymbolFlags.Alias) === 0 ? exportedSymbol : targetSymbol;
  return DECLARATION_SPACES.filter((space) => symbolOccupiesSpace(symbol, space));
}

function inspectDeclarationSpaces(
  evidence: InstalledPackageModule,
  symbol: ts.Symbol,
  occupiedSpaces: readonly DeclarationSpace[],
  aliasDeclaration: AliasDeclaration | undefined,
  namespaceMembers: readonly NamespaceMemberEvidence[],
): readonly ExportDeclarationSpace[] {
  const declarations = inspectableDeclarations(symbol);
  return occupiedSpaces.map((space): ExportDeclarationSpace => {
    if (space === "namespace") {
      return {
        space,
        members: inspectNamespaceMembers(evidence, namespaceMembers),
      };
    }
    return {
      space,
      declarations: inspectedDeclarations(
        evidence,
        declarations.filter((declaration) => declarationSpaces(declaration).includes(space)),
        aliasDeclaration,
      ),
    };
  });
}

function inspectedDeclarations(
  evidence: InstalledPackageModule,
  declarations: readonly ts.Declaration[],
  aliasDeclaration: AliasDeclaration | undefined,
): readonly InspectedDeclaration[] {
  if (declarations.length > 0) {
    return declarations.map((declaration) => inspectDeclaration(evidence, declaration));
  }
  return aliasDeclaration === undefined
    ? []
    : [inspectDeclaration(evidence, aliasDeclaration, "alias")];
}

function inspectNamespaceMemberEvidence(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly NamespaceMemberEvidence[] {
  return collectNamespaceMembers(
    checker,
    symbol,
    {
      memberCount: 0,
      visited: new Set(),
    },
    0,
  );
}

function collectNamespaceMembers(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  state: NamespaceTraversalState,
  depth: number,
): readonly NamespaceMemberEvidence[] {
  if ((symbol.flags & ts.SymbolFlags.Module) === 0) {
    return [];
  }
  assertNamespaceTraversalAllowed(symbol, state, depth);
  // `visited` tracks the current path rather than all previously seen symbols,
  // allowing shared namespaces in sibling branches while rejecting cycles.
  state.visited.add(symbol);
  const exportedMembers = checker.getExportsOfModule(symbol);
  reserveNamespaceMembers(state, exportedMembers.length);
  const members = exportedMembers.map((member) =>
    inspectNamespaceMember(checker, member, state, depth),
  );
  state.visited.delete(symbol);
  return members;
}

function assertNamespaceTraversalAllowed(
  symbol: ts.Symbol,
  state: NamespaceTraversalState,
  depth: number,
): void {
  if (depth > MAX_SUPPORTING_TYPE_DEPTH) {
    throw new InspectionLimitError("Inspection exceeded its namespace traversal depth limit.");
  }
  if (state.visited.has(symbol)) {
    throw new UnsupportedInspectionError(
      "The selected Module Export contains a circular namespace re-export.",
    );
  }
}

function reserveNamespaceMembers(state: NamespaceTraversalState, count: number): void {
  state.memberCount += count;
  if (state.memberCount > MAX_NAMESPACE_MEMBERS) {
    throw new InspectionLimitError("Inspection exceeded its namespace member limit.");
  }
}

function inspectNamespaceMember(
  checker: ts.TypeChecker,
  member: ts.Symbol,
  state: NamespaceTraversalState,
  depth: number,
): NamespaceMemberEvidence {
  const aliasDeclaration = findAliasDeclaration(member);
  const target = resolveExportTarget(checker, member);
  const namespaceAliasDeclaration =
    aliasDeclaration !== undefined && ts.isNamespaceExport(aliasDeclaration)
      ? [aliasDeclaration]
      : [];
  const declarations = [...namespaceAliasDeclaration, ...inspectableDeclarations(target)];
  assertDeclarationLimit(declarations);
  return {
    name: member.getName(),
    declarations,
    members: collectNamespaceMembers(checker, target, state, depth + 1),
  };
}

function inspectNamespaceMembers(
  evidence: InstalledPackageModule,
  members: readonly NamespaceMemberEvidence[],
): readonly ExportNamespaceMember[] {
  return members.map((member) => ({
    name: member.name,
    declarations: member.declarations.map((declaration) =>
      inspectDeclaration(evidence, declaration),
    ),
    members: inspectNamespaceMembers(evidence, member.members),
  }));
}

function namespaceMemberDeclarations(
  members: readonly NamespaceMemberEvidence[],
): readonly ts.Declaration[] {
  return members.flatMap((member) => [
    ...member.declarations,
    ...namespaceMemberDeclarations(member.members),
  ]);
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
  // TypeScript preserves order within one source file but can interleave
  // signatures from merged declarations. Rank their source files explicitly.
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
  evidence: InstalledPackageModule,
  selectedSymbol: ts.Symbol,
  namespaceMembers: readonly NamespaceMemberEvidence[],
): readonly SupportingType[] {
  // Traverse only references reachable from the selected Public Interface. The
  // visited set prevents cycles while depth and count budgets bound expansion.
  const supportingTypes: SupportingType[] = [];
  const visited = new Set<ts.Symbol>([selectedSymbol]);
  const visitedInferredTypes = new Set<ts.Type>();

  const inspectSymbol = (
    symbol: ts.Symbol,
    referenceKind: SupportingReferenceKind,
    depth: number,
  ): boolean => {
    const resolvedSymbol = resolveExportTarget(evidence.checker, symbol);
    const declarations = unvisitedSupportingDeclarations(resolvedSymbol, referenceKind, visited);
    if (declarations.length === 0) {
      return false;
    }
    assertSupportingTypeBudget(depth, supportingTypes.length);
    visited.add(resolvedSymbol);
    supportingTypes.push({
      name: resolvedSymbol.getName(),
      declarations: declarations.map((declaration) => inspectDeclaration(evidence, declaration)),
    });
    declarations.forEach((declaration) => {
      visitTypeReferences(publicDeclarationSyntax(evidence.checker, declaration), (reference) =>
        inspectReference(reference, depth + 1),
      );
      inferredPublicTypes(evidence.checker, declaration).forEach((type) => {
        inspectInferredType(type, depth + 1);
      });
    });
    return true;
  };

  const inspectReference = (reference: SupportingReference, depth: number): void => {
    const referenced = evidence.checker.getSymbolAtLocation(reference.location);
    if (referenced === undefined) {
      return;
    }
    inspectSymbol(referenced, reference.kind, depth);
  };

  const inspectInferredType = (type: ts.Type, depth: number): void => {
    if (visitedInferredTypes.has(type)) {
      return;
    }
    visitedInferredTypes.add(type);
    const symbol = inferredTypeSymbol(type);
    if (symbol !== undefined) {
      inspectSymbol(symbol, "type", depth);
    }
    inferredPublicTypeChildren(evidence.checker, type).forEach((childType) => {
      inspectInferredType(childType, depth + 1);
    });
  };

  for (const declaration of supportingRootDeclarations(selectedSymbol, namespaceMembers)) {
    visitTypeReferences(publicDeclarationSyntax(evidence.checker, declaration), (reference) =>
      inspectReference(reference, 1),
    );
    for (const type of inferredPublicTypes(evidence.checker, declaration)) {
      inspectInferredType(type, 1);
    }
  }
  return supportingTypes;
}

function unvisitedSupportingDeclarations(
  symbol: ts.Symbol,
  referenceKind: SupportingReferenceKind,
  visited: ReadonlySet<ts.Symbol>,
): readonly ts.Declaration[] {
  return visited.has(symbol) ? [] : supportingTypeDeclarations(symbol, referenceKind);
}

function inferredTypeSymbol(type: ts.Type): ts.Symbol | undefined {
  return type.aliasSymbol ?? type.getSymbol();
}

function supportingRootDeclarations(
  selectedSymbol: ts.Symbol,
  namespaceMembers: readonly NamespaceMemberEvidence[],
): readonly ts.Declaration[] {
  return [
    ...inspectableDeclarations(selectedSymbol),
    ...namespaceMemberDeclarations(namespaceMembers),
  ];
}

function assertSupportingTypeBudget(depth: number, supportingTypeCount: number): void {
  if (depth > MAX_SUPPORTING_TYPE_DEPTH) {
    throw new InspectionLimitError("Inspection exceeded its Supporting Type depth limit.");
  }
  if (supportingTypeCount >= MAX_SUPPORTING_TYPES) {
    throw new InspectionLimitError("Inspection exceeded its Supporting Type limit.");
  }
}

function visitTypeReferences(
  node: ts.Node,
  visitReference: (reference: SupportingReference) => void,
): void {
  if (isPrivateDeclaration(node)) {
    return;
  }
  const reference = supportingReference(node);
  if (reference !== undefined) {
    visitReference(reference);
  }
  ts.forEachChild(node, (child) => visitTypeReferences(child, visitReference));
}

function supportingTypeDeclarations(
  symbol: ts.Symbol,
  referenceKind: SupportingReferenceKind,
): readonly ts.Declaration[] {
  // `typeof X` needs X's value declaration; ordinary type references admit only
  // named type declarations and must not drift into implementation symbols.
  const declarations = (symbol.declarations ?? []).filter((declaration) =>
    referenceKind === "type-query"
      ? declarationSpaces(declaration).includes("value")
      : isNamedTypeDeclaration(declaration),
  );
  assertDeclarationLimit(declarations);
  return declarations;
}

function isNamedTypeDeclaration(
  declaration: ts.Declaration,
): declaration is
  | ts.ClassDeclaration
  | ts.EnumDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration {
  return (
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  );
}

function isTypeOnlyAlias(declaration: AliasDeclaration): boolean {
  return (
    typeOnlyExportSpecifier(declaration) ??
    typeOnlyNamespaceExport(declaration) ??
    typeOnlyImportEqualsDeclaration(declaration) ??
    false
  );
}

function supportingReference(node: ts.Node): SupportingReference | undefined {
  if (ts.isTypeQueryNode(node)) {
    return { kind: "type-query", location: node.exprName };
  }
  const location = ordinaryTypeReferenceLocation(node);
  return location === undefined ? undefined : { kind: "type", location };
}

function ordinaryTypeReferenceLocation(node: ts.Node): ts.Node | undefined {
  if (ts.isTypeReferenceNode(node)) {
    return node.typeName;
  }
  if (ts.isExpressionWithTypeArguments(node)) {
    return node.expression;
  }
  return ts.isImportTypeNode(node) ? node.qualifier : undefined;
}

function typeOnlyExportSpecifier(declaration: AliasDeclaration): boolean | undefined {
  return ts.isExportSpecifier(declaration)
    ? declaration.isTypeOnly || declaration.parent.parent.isTypeOnly
    : undefined;
}

function typeOnlyNamespaceExport(declaration: AliasDeclaration): boolean | undefined {
  return ts.isNamespaceExport(declaration) ? declaration.parent.isTypeOnly : undefined;
}

function typeOnlyImportEqualsDeclaration(declaration: AliasDeclaration): boolean | undefined {
  return ts.isImportEqualsDeclaration(declaration) ? declaration.isTypeOnly : undefined;
}
