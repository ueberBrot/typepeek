import ts from "@typescript/typescript6";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  type AliasDeclaration,
  findFocusedExportAliasDeclaration,
  type FocusedExportResolution,
  resolveFocusedExport,
  resolveFocusedExportSymbol,
  resolveFocusedExportTarget,
} from "#typepeek/inspection/focused-export";
import type { InspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import { inspectPackageDocumentation } from "#typepeek/inspection/package-documentation";
import type {
  DeclarationKind,
  DeclarationSpace,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectedModuleExport,
  SupportingType,
} from "#typepeek/inspection/protocol";
import {
  inferredPublicTypeChildren,
  isPrivateDeclaration,
  projectPublicDeclaration,
  publicDeclarations,
} from "#typepeek/inspection/public-declaration-projection";
import { renderPublicDeclaration } from "#typepeek/inspection/public-declaration-rendering";
import {
  ExportInspectionConstruction,
  type InspectionResultConstructionContext,
} from "#typepeek/inspection/result-construction";
import { inspectResolvedExportSignatures } from "#typepeek/inspection/signature-inspection";
import { shouldExpandSupportingDeclaration } from "#typepeek/inspection/supporting-type-policy";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/typescript-standard-library";

const MAX_DECLARATIONS_PER_SYMBOL = 128;
const MAX_DECLARATION_BYTES = 64 * 1_024;
const MAX_NAMESPACE_MEMBERS = 128;
const MAX_NAMESPACE_DEPTH = 8;
const MAX_SUPPORTING_TYPE_DEPTH = 12;
const MAX_SUPPORTING_TYPES = 96;
const MAX_SUPPORTING_TRAVERSAL_DEPTH = 64;
const MAX_SUPPORTING_TRAVERSAL_NODES = 20_000;
const MAX_INFERRED_TYPE_NODES = 4_096;

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

interface NamespaceMemberEvidence {
  readonly name: string;
  readonly declarations: readonly ts.Declaration[];
  readonly members: readonly NamespaceMemberEvidence[];
}

interface NamespaceTraversalState {
  memberCount: number;
  readonly visited: Set<ts.Symbol>;
}

interface SupportingTraversalState {
  astNodeCount: number;
  inferredTypeCount: number;
}

type SupportingReferenceKind = "type" | "type-query";

interface SupportingReference {
  readonly kind: SupportingReferenceKind;
  readonly location: ts.Node;
}

function inspectDeclaration(
  evidence: InspectableModuleEvidence,
  declaration: ts.Declaration,
  construction: ExportInspectionConstruction,
  kindOverride: "alias",
): InspectedDeclaration & { readonly kind: "alias" };
function inspectDeclaration(
  evidence: InspectableModuleEvidence,
  declaration: ts.Declaration,
  construction: ExportInspectionConstruction,
  kindOverride?: DeclarationKind,
): InspectedDeclaration;
function inspectDeclaration(
  evidence: InspectableModuleEvidence,
  declaration: ts.Declaration,
  construction: ExportInspectionConstruction,
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
  const inspectedDeclaration: InspectedDeclaration = {
    kind,
    text,
    provenance: {
      ...provenance,
      line: start.line + 1,
      column: start.character + 1,
    },
  };
  return construction.declaration(inspectedDeclaration);
}

function inspectableDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly ts.Declaration[] {
  const declarations = publicDeclarations(checker, symbol.declarations ?? []).filter(
    (declaration) => declarationKind(declaration) !== undefined,
  );
  assertDeclarationLimit(declarations);
  return declarations;
}

function assertSupportedSelectedDeclarationKind(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
): void {
  const declarations = publicDeclarations(checker, symbol.declarations ?? []);
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
 * Produces a bounded Export Inspection from one Inspectable Module backed by
 * Installed Evidence. Returns `undefined` only when the named Module Export is
 * absent; unsupported declaration shapes and exhausted budgets use typed errors.
 */
export function inspectFocusedModuleExport(
  evidence: InspectableModuleEvidence,
  exportName: string,
  constructionContext: InspectionResultConstructionContext,
): ExportInspection | undefined {
  const construction = new ExportInspectionConstruction(constructionContext);
  const resolution = resolveFocusedExport(evidence.checker, evidence.moduleSymbol, exportName);
  if (resolution === undefined) {
    return undefined;
  }

  const { exportedSymbol, targetSymbol } = resolution;
  const aliasDeclaration = findFocusedExportAliasDeclaration(exportedSymbol);
  assertSupportedSelectedDeclarationKind(evidence.checker, targetSymbol, aliasDeclaration);
  const spaces = occupiedDeclarationSpaces(exportedSymbol, targetSymbol, aliasDeclaration);
  const namespaceMembers = spaces.includes("namespace")
    ? inspectNamespaceMemberEvidence(evidence.checker, targetSymbol)
    : [];
  const packageDocumentationEvidence = inspectPackageDocumentation(
    evidence.checker,
    exportedSymbol,
    targetSymbol,
    aliasDeclaration,
  );
  const packageDocumentation =
    packageDocumentationEvidence === undefined
      ? undefined
      : construction.documentation(packageDocumentationEvidence);
  const moduleExport = inspectModuleExport(
    evidence,
    exportedSymbol,
    targetSymbol,
    resolution,
    aliasDeclaration,
    spaces,
    namespaceMembers,
    construction,
  );
  const supportingTypes = inspectSupportingTypes(
    evidence,
    targetSymbol,
    namespaceMembers,
    construction,
  );
  return construction.result(moduleExport, supportingTypes, packageDocumentation);
}

function inspectModuleExport(
  evidence: InspectableModuleEvidence,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  resolution: FocusedExportResolution,
  aliasDeclaration: AliasDeclaration | undefined,
  spaces: readonly DeclarationSpace[],
  namespaceMembers: readonly NamespaceMemberEvidence[],
  construction: ExportInspectionConstruction,
): InspectedModuleExport {
  const alias = inspectAlias(evidence, resolution, aliasDeclaration, construction);
  const declarationSpaces = inspectDeclarationSpaces(
    evidence,
    targetSymbol,
    spaces,
    aliasDeclaration,
    namespaceMembers,
    construction,
  );
  const signatures = inspectResolvedExportSignatures(evidence.checker, resolution, (value) =>
    construction.signature(value),
  );
  return construction.moduleExport({
    name: exportedSymbol.getName(),
    ...(alias === undefined ? {} : { alias }),
    spaces: declarationSpaces,
    signatures,
  });
}

function inspectAlias(
  evidence: InspectableModuleEvidence,
  resolution: FocusedExportResolution,
  aliasDeclaration: AliasDeclaration | undefined,
  construction: ExportInspectionConstruction,
): ExportAlias | undefined {
  if (aliasDeclaration === undefined || resolution.aliasTargetName === undefined) {
    return undefined;
  }
  const declaration = inspectDeclaration(evidence, aliasDeclaration, construction, "alias");
  return construction.alias(resolution.aliasTargetName, declaration);
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
  evidence: InspectableModuleEvidence,
  symbol: ts.Symbol,
  occupiedSpaces: readonly DeclarationSpace[],
  aliasDeclaration: AliasDeclaration | undefined,
  namespaceMembers: readonly NamespaceMemberEvidence[],
  construction: ExportInspectionConstruction,
): readonly ExportDeclarationSpace[] {
  const declarations = inspectableDeclarations(evidence.checker, symbol);
  return occupiedSpaces.map((space): ExportDeclarationSpace => {
    if (space === "namespace") {
      return construction.namespaceSpace(
        inspectNamespaceMembers(evidence, namespaceMembers, construction),
      );
    }
    return construction.declarationSpace(
      space,
      inspectedDeclarations(
        evidence,
        declarations.filter((declaration) => declarationSpaces(declaration).includes(space)),
        aliasDeclaration,
        construction,
      ),
    );
  });
}

function inspectedDeclarations(
  evidence: InspectableModuleEvidence,
  declarations: readonly ts.Declaration[],
  aliasDeclaration: AliasDeclaration | undefined,
  construction: ExportInspectionConstruction,
): readonly InspectedDeclaration[] {
  if (declarations.length > 0) {
    return declarations.map((declaration) =>
      inspectDeclaration(evidence, declaration, construction),
    );
  }
  return aliasDeclaration === undefined
    ? []
    : [inspectDeclaration(evidence, aliasDeclaration, construction, "alias")];
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
  if (depth > MAX_NAMESPACE_DEPTH) {
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
  const aliasDeclaration = findFocusedExportAliasDeclaration(member);
  const target = resolveFocusedExportSymbol(checker, member).targetSymbol;
  const namespaceAliasDeclaration =
    aliasDeclaration !== undefined && ts.isNamespaceExport(aliasDeclaration)
      ? [aliasDeclaration]
      : [];
  const declarations = [...namespaceAliasDeclaration, ...inspectableDeclarations(checker, target)];
  assertDeclarationLimit(declarations);
  return {
    name: member.getName(),
    declarations,
    members: collectNamespaceMembers(checker, target, state, depth + 1),
  };
}

function inspectNamespaceMembers(
  evidence: InspectableModuleEvidence,
  members: readonly NamespaceMemberEvidence[],
  construction: ExportInspectionConstruction,
): readonly ExportNamespaceMember[] {
  return members.map((member) => {
    const declarations = member.declarations.map((declaration) =>
      inspectDeclaration(evidence, declaration, construction),
    );
    const childMembers = inspectNamespaceMembers(evidence, member.members, construction);
    return construction.namespaceMember(member.name, declarations, childMembers);
  });
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

function inspectSupportingTypes(
  evidence: InspectableModuleEvidence,
  selectedSymbol: ts.Symbol,
  namespaceMembers: readonly NamespaceMemberEvidence[],
  construction: ExportInspectionConstruction,
): readonly SupportingType[] {
  // Traverse only references reachable from the selected Public Interface. The
  // visited set prevents cycles while depth and count budgets bound expansion.
  const supportingTypes: SupportingType[] = [];
  const visited = new Set<ts.Symbol>([selectedSymbol]);
  const visitedInferredTypes = new Set<ts.Type>();
  const traversal: SupportingTraversalState = { astNodeCount: 0, inferredTypeCount: 0 };

  const inspectSymbol = (
    symbol: ts.Symbol,
    referenceKind: SupportingReferenceKind,
    depth: number,
  ): boolean => {
    const resolvedSymbol = resolveFocusedExportTarget(evidence.checker, symbol);
    const declarations = unvisitedSupportingDeclarations(resolvedSymbol, referenceKind, visited);
    if (declarations.length === 0) {
      return false;
    }
    assertSupportingTypeBudget(depth, supportingTypes.length);
    visited.add(resolvedSymbol);
    const inspectedSupportingDeclarations = declarations.map((declaration) =>
      inspectDeclaration(evidence, declaration, construction),
    );
    supportingTypes.push(
      construction.supportingType(resolvedSymbol.getName(), inspectedSupportingDeclarations),
    );
    declarations
      .filter((declaration) => shouldExpandSupporting(evidence, declaration))
      .forEach((declaration) => {
        const projection = projectPublicDeclaration(evidence.checker, declaration);
        visitTypeReferences(
          projection.syntax,
          (reference) => inspectReference(reference, depth + 1),
          traversal,
        );
        projection.inferredTypes.forEach((type) => {
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
    reserveInferredTypeTraversal(traversal, depth);
    visitedInferredTypes.add(type);
    const symbol = inferredTypeSymbol(type);
    if (symbol !== undefined) {
      inspectSymbol(symbol, symbol.flags & ts.SymbolFlags.Namespace ? "type-query" : "type", depth);
    }
    inferredPublicTypeChildren(evidence.checker, type).forEach((childType) => {
      inspectInferredType(childType, depth + 1);
    });
  };

  for (const declaration of supportingRootDeclarations(
    evidence.checker,
    selectedSymbol,
    namespaceMembers,
  )) {
    const projection = projectPublicDeclaration(evidence.checker, declaration);
    visitTypeReferences(
      projection.syntax,
      (reference) => inspectReference(reference, 1),
      traversal,
    );
    for (const type of projection.inferredTypes) {
      inspectInferredType(type, 1);
    }
  }
  return supportingTypes;
}

function shouldExpandSupporting(
  evidence: InspectableModuleEvidence,
  declaration: ts.Declaration,
): boolean {
  return shouldExpandSupportingDeclaration(evidence.supportingTypeScope, declaration);
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
  checker: ts.TypeChecker,
  selectedSymbol: ts.Symbol,
  namespaceMembers: readonly NamespaceMemberEvidence[],
): readonly ts.Declaration[] {
  return [
    ...inspectableDeclarations(checker, selectedSymbol),
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
  traversal: SupportingTraversalState,
  depth = 0,
): void {
  reserveAstTraversal(traversal, depth);
  if (isPrivateDeclaration(node)) {
    return;
  }
  const reference = supportingReference(node);
  if (reference !== undefined) {
    visitReference(reference);
  }
  ts.forEachChild(node, (child) =>
    visitTypeReferences(child, visitReference, traversal, depth + 1),
  );
}

function reserveAstTraversal(traversal: SupportingTraversalState, depth: number): void {
  traversal.astNodeCount += 1;
  if (
    depth > MAX_SUPPORTING_TRAVERSAL_DEPTH ||
    traversal.astNodeCount > MAX_SUPPORTING_TRAVERSAL_NODES
  ) {
    throw new InspectionLimitError("Inspection exceeded its Supporting Type traversal limit.");
  }
}

function reserveInferredTypeTraversal(traversal: SupportingTraversalState, depth: number): void {
  traversal.inferredTypeCount += 1;
  if (
    depth > MAX_SUPPORTING_TRAVERSAL_DEPTH ||
    traversal.inferredTypeCount > MAX_INFERRED_TYPE_NODES
  ) {
    throw new InspectionLimitError("Inspection exceeded its Supporting Type traversal limit.");
  }
}

function supportingTypeDeclarations(
  symbol: ts.Symbol,
  referenceKind: SupportingReferenceKind,
): readonly ts.Declaration[] {
  // `typeof X` needs X's value declaration; ordinary type references admit only
  // named type declarations and must not drift into implementation symbols.
  const declarations = (symbol.declarations ?? []).filter(
    (declaration) =>
      !isTypeScriptStandardLibraryDeclaration(declaration.getSourceFile().fileName) &&
      (referenceKind === "type-query"
        ? declarationSpaces(declaration).some((space) => space === "value" || space === "namespace")
        : isNamedTypeDeclaration(declaration)),
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
