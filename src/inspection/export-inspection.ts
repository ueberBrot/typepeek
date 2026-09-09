import ts from "@typescript/typescript6";

import { MAX_NAMESPACE_DEPTH } from "#typepeek/inspection/budget-policy";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/declaration-limits";
import {
  declarationOwnerIsMember,
  inferredPublicTypeChildren,
  isPrivateDeclaration,
  isNamedTypeDeclarationSyntax,
  projectPublicDeclaration,
  type DeclarationProjectionContext,
  publicDeclarations,
  renderPublicDeclaration,
} from "#typepeek/inspection/declaration-projection";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  type AliasDeclaration,
  type FocusedExportResolution,
  resolveFocusedExport,
  resolveFocusedExportSymbol,
  resolveFocusedExportTarget,
} from "#typepeek/inspection/focused-export";
import type { InspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import {
  publicMemberDeclarations,
  discoverPublicMembers,
  resolvePublicMemberPath,
  type PublicMemberPathResolution,
} from "#typepeek/inspection/member-inspection";
import { MAX_MEMBER_PATH_SEGMENTS, type MemberPath } from "#typepeek/inspection/member-path";
import { inspectPackageDocumentation } from "#typepeek/inspection/package-documentation";
import type {
  MemberDiscovery,
  DeclarationInspection,
  DeclarationKind,
  DeclarationSpace,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectedModuleExport,
  MemberInspection,
  SupportingType,
} from "#typepeek/inspection/protocol";
import {
  type FocusedInspectionConstruction,
  type InspectionResultConstruction,
} from "#typepeek/inspection/result-construction";
import { inspectResolvedExportSignatures } from "#typepeek/inspection/signature-inspection";
import { shouldExpandSupportingDeclaration } from "#typepeek/inspection/supporting-type-policy";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/typescript-standard-library";

const MAX_DECLARATION_BYTES = 64 * 1024;

const MAX_NAMESPACE_MEMBERS = 128;

const MAX_SUPPORTING_TYPE_DEPTH = 12;

const MAX_SUPPORTING_TYPES = 96;

const MAX_SUPPORTING_TRAVERSAL_DEPTH = 64;

const MAX_SUPPORTING_TRAVERSAL_NODES = 20000;

const MAX_INFERRED_TYPE_NODES = 4096;

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
  [ts.SyntaxKind.PropertyDeclaration, "property"],
  [ts.SyntaxKind.PropertySignature, "property"],
  [ts.SyntaxKind.MethodDeclaration, "method"],
  [ts.SyntaxKind.MethodSignature, "method"],
  [ts.SyntaxKind.Constructor, "constructor"],
  [ts.SyntaxKind.ConstructSignature, "constructor"],
  [ts.SyntaxKind.GetAccessor, "accessor"],
  [ts.SyntaxKind.SetAccessor, "accessor"],
  [ts.SyntaxKind.EnumMember, "enum-member"],
]);

const DECLARATION_POLICY_BY_KIND: Readonly<
  Record<
    DeclarationKind,
    {
      readonly spaces: readonly DeclarationSpace[];
      readonly supportsTypeQuery: boolean;
    }
  >
> = {
  alias: { spaces: [], supportsTypeQuery: false },
  class: { spaces: ["type", "value"], supportsTypeQuery: true },
  enum: { spaces: ["type", "value"], supportsTypeQuery: true },
  function: { spaces: ["value"], supportsTypeQuery: true },
  interface: { spaces: ["type"], supportsTypeQuery: false },
  namespace: { spaces: ["value", "namespace"], supportsTypeQuery: true },
  "type-alias": { spaces: ["type"], supportsTypeQuery: false },
  variable: { spaces: ["value"], supportsTypeQuery: true },
  accessor: { spaces: ["value"], supportsTypeQuery: false },
  constructor: { spaces: ["value"], supportsTypeQuery: false },
  method: { spaces: ["value"], supportsTypeQuery: false },
  property: { spaces: ["value"], supportsTypeQuery: false },
  "enum-member": { spaces: ["value"], supportsTypeQuery: false },
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

interface FocusedDeclarationEvidence {
  readonly construction: FocusedInspectionConstruction;
  readonly namespaceMembers: readonly NamespaceMemberEvidence[];
  readonly resolution: FocusedExportResolution;
}

type SupportingReferenceKind = "type" | "type-query";

interface SupportingReference {
  readonly kind: SupportingReferenceKind;
  readonly location: ts.Node;
}

type FocusedMemberInspection =
  | {
      readonly status: "success";
      readonly result: MemberInspection;
    }
  | {
      readonly status:
        | "ambiguous-member"
        | "export-not-found"
        | "member-not-found"
        | "unsupported-member";
    };

/** Owns focused Module Export inspection and traversal for one Inspection Plan. */
export function createModuleExportInspection(
  evidence: InspectableModuleEvidence,
  constructionOwner: InspectionResultConstruction,
) {
  const traversal = { astNodeCount: 0, inferredTypeCount: 0, validatedTypes: new Set<ts.Type>() };
  const projectionContext: DeclarationProjectionContext = {
    moduleSymbol: evidence.moduleSymbol,
    reserveTraversal: reserveAstTraversal,
    reserveTypeTraversal: reserveInferredTypeTraversal,
    validatedTypes: traversal.validatedTypes,
  };
  return {
    inspectExport: inspectFocusedModuleExport,
    inspectDeclarations: inspectFocusedModuleExportDeclarations,
    inspectMember: inspectFocusedModuleExportMember,
    discoverMembers: discoverFocusedModuleExportMembers,
  };
  function inspectDeclaration(
    declaration: ts.Declaration,
    construction: FocusedInspectionConstruction,
    kindOverride: "alias",
  ): InspectedDeclaration & {
    readonly kind: "alias";
  };

  function inspectDeclaration(
    declaration: ts.Declaration,
    construction: FocusedInspectionConstruction,
    kindOverride?: DeclarationKind,
  ): InspectedDeclaration;

  function inspectDeclaration(
    declaration: ts.Declaration,
    construction: FocusedInspectionConstruction,
    kindOverride?: DeclarationKind,
  ): InspectedDeclaration {
    const sourceFile = declaration.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile, false));
    const text = renderPublicDeclaration(evidence.checker, declaration, projectionContext);
    if (Buffer.byteLength(text) > MAX_DECLARATION_BYTES) {
      throw new InspectionLimitError(
        "declaration-output",
        "Inspection exceeded its declaration output limit.",
      );
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

  /**
   * Produces a bounded Export Inspection from one Inspectable Module backed by
   * Installed Evidence. Returns `undefined` only when the named Module Export is
   * absent; unsupported declaration shapes and exhausted budgets use typed errors.
   */
  function inspectFocusedModuleExport(exportName: string): ExportInspection | undefined {
    const focused = readFocusedDeclarationEvidence(exportName);
    if (focused === undefined) {
      return undefined;
    }
    const packageDocumentationEvidence = inspectPackageDocumentation(
      evidence.checker,
      focused.resolution.exportedSymbol,
      focused.resolution.targetSymbol,
      focused.resolution.aliasDeclaration,
    );
    const packageDocumentation =
      packageDocumentationEvidence === undefined
        ? undefined
        : focused.construction.documentation(packageDocumentationEvidence);
    const moduleExport = inspectModuleExport(focused);
    const supportingTypes = inspectSupportingTypes(
      focused.resolution.targetSymbol,
      focused.namespaceMembers,
      focused.construction,
    );
    return focused.construction.exportResult(moduleExport, supportingTypes, packageDocumentation);
  }

  /** Inspects only one Module Export's declarations, without signatures or Supporting Types. */
  function inspectFocusedModuleExportDeclarations(
    exportName: string,
  ): DeclarationInspection | undefined {
    const focused = readFocusedDeclarationEvidence(exportName);
    if (focused === undefined) {
      return undefined;
    }
    const alias = inspectAlias(focused.resolution, focused.construction);
    const moduleExport = focused.construction.moduleExportDeclarations({
      name: focused.resolution.exportedSymbol.getName(),
      ...(alias === undefined ? {} : { alias }),
      spaces: inspectDeclarationSpaces(focused),
    });
    return focused.construction.declarationResult(moduleExport);
  }

  function readFocusedDeclarationEvidence(
    exportName: string,
  ): FocusedDeclarationEvidence | undefined {
    const resolution = resolveFocusedExport(evidence.checker, evidence.moduleSymbol, exportName);
    if (resolution === undefined) {
      return undefined;
    }
    const { targetSymbol, aliasDeclaration, spaces } = resolution;
    assertSupportedSelectedDeclarationKind(evidence.checker, targetSymbol, aliasDeclaration);
    return {
      construction: constructionOwner.focused(),
      namespaceMembers: spaces.includes("namespace")
        ? inspectNamespaceMemberEvidence(evidence.checker, targetSymbol)
        : [],
      resolution,
    };
  }

  /** Inspects exactly one public member path without traversing unrelated declarations. */
  function inspectFocusedModuleExportMember(
    exportName: string,
    memberPath: MemberPath,
  ): FocusedMemberInspection {
    const memberResolution = resolveFocusedMember(exportName, memberPath);
    if (memberResolution.status !== "success") {
      return { status: memberResolution.status };
    }
    const memberDeclarations = inspectableMemberDeclarations(
      evidence.checker,
      memberResolution.symbol,
    );
    if (memberDeclarations.length === 0) {
      return { status: "unsupported-member" };
    }
    const construction = constructionOwner.focused();
    const declarations = memberDeclarations.map((declaration) =>
      inspectDeclaration(declaration, construction),
    );
    return {
      status: "success",
      result: construction.memberResult(exportName, memberPath, declarations),
    };
  }

  /** Discovers one export's immediate members after resolving an optional exact path. */
  function discoverFocusedModuleExportMembers(
    exportName: string,
    memberPath: MemberPath,
    query: string | undefined,
  ):
    | {
        readonly status: "success";
        readonly result: MemberDiscovery;
      }
    | Exclude<
        FocusedMemberInspection,
        {
          readonly status: "success";
        }
      > {
    const memberResolution = resolveFocusedMember(exportName, memberPath);
    if (memberResolution.status !== "success") {
      return memberResolution;
    }
    const discovery = discoverPublicMembers(
      evidence.checker,
      memberResolution.symbol,
      query,
      constructionOwner,
    );
    if (memberPath.length === MAX_MEMBER_PATH_SEGMENTS && discovery.totalMembers > 0) {
      throw new UnsupportedInspectionError(
        "Member Discovery cannot select children beyond the Member path depth limit.",
      );
    }
    return {
      status: "success",
      result: constructionOwner.memberDiscovery(
        exportName,
        memberPath,
        query,
        discovery.totalMembers,
        discovery.members,
      ),
    };
  }

  function resolveFocusedMember(
    exportName: string,
    memberPath: MemberPath,
  ):
    | PublicMemberPathResolution
    | {
        readonly status: "export-not-found";
      } {
    const resolution = resolveFocusedExport(evidence.checker, evidence.moduleSymbol, exportName);
    return resolution === undefined
      ? { status: "export-not-found" }
      : resolvePublicMemberPath(
          evidence.checker,
          resolution.targetSymbol,
          memberPath,
          constructionOwner,
        );
  }

  function inspectModuleExport(focused: FocusedDeclarationEvidence): InspectedModuleExport {
    const { resolution, construction } = focused;
    const alias = inspectAlias(resolution, construction);
    const declarationSpaces = inspectDeclarationSpaces(focused);
    const signatures = inspectResolvedExportSignatures(evidence.checker, resolution, (value) =>
      construction.signature(value),
    );
    return construction.moduleExport({
      name: resolution.exportedSymbol.getName(),
      ...(alias === undefined ? {} : { alias }),
      spaces: declarationSpaces,
      signatures,
    });
  }

  function inspectAlias(
    resolution: FocusedExportResolution,
    construction: FocusedInspectionConstruction,
  ): ExportAlias | undefined {
    const { aliasDeclaration } = resolution;
    if (aliasDeclaration === undefined || resolution.aliasTargetName === undefined) {
      return undefined;
    }
    const declaration = inspectDeclaration(aliasDeclaration, construction, "alias");
    return construction.alias(resolution.aliasTargetName, declaration);
  }

  function inspectDeclarationSpaces({
    resolution,
    namespaceMembers,
    construction,
  }: FocusedDeclarationEvidence): readonly ExportDeclarationSpace[] {
    const { targetSymbol, aliasDeclaration, spaces } = resolution;
    const declarations = inspectableDeclarations(evidence.checker, targetSymbol);
    return spaces.map((space): ExportDeclarationSpace => {
      if (space === "namespace") {
        return construction.namespaceSpace(inspectNamespaceMembers(namespaceMembers, construction));
      }
      return construction.declarationSpace(
        space,
        inspectedDeclarations(
          declarations.filter((declaration) => declarationSpaces(declaration).includes(space)),
          aliasDeclaration,
          construction,
        ),
      );
    });
  }

  function inspectedDeclarations(
    declarations: readonly ts.Declaration[],
    aliasDeclaration: AliasDeclaration | undefined,
    construction: FocusedInspectionConstruction,
  ): readonly InspectedDeclaration[] {
    if (declarations.length > 0) {
      return declarations.map((declaration) => inspectDeclaration(declaration, construction));
    }
    return aliasDeclaration === undefined
      ? []
      : [inspectDeclaration(aliasDeclaration, construction, "alias")];
  }

  function inspectNamespaceMembers(
    members: readonly NamespaceMemberEvidence[],
    construction: FocusedInspectionConstruction,
  ): readonly ExportNamespaceMember[] {
    return members.map((member) => {
      const declarations = member.declarations.map((declaration) =>
        inspectDeclaration(declaration, construction),
      );
      const childMembers = inspectNamespaceMembers(member.members, construction);
      return construction.namespaceMember(member.name, declarations, childMembers);
    });
  }

  function inspectSupportingTypes(
    selectedSymbol: ts.Symbol,
    namespaceMembers: readonly NamespaceMemberEvidence[],
    construction: FocusedInspectionConstruction,
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
      const resolvedSymbol = resolveFocusedExportTarget(evidence.checker, symbol);
      const declarations = unvisitedSupportingDeclarations(resolvedSymbol, referenceKind, visited);
      if (declarations.length === 0) {
        return false;
      }
      assertSupportingTypeBudget(depth, supportingTypes.length);
      visited.add(resolvedSymbol);
      const inspectedSupportingDeclarations = declarations.map((declaration) =>
        inspectDeclaration(declaration, construction),
      );
      supportingTypes.push(
        construction.supportingType(resolvedSymbol.getName(), inspectedSupportingDeclarations),
      );
      declarations
        .filter((declaration) => shouldExpandSupporting(declaration))
        .forEach((declaration) => {
          const projection = projectPublicDeclaration(
            evidence.checker,
            declaration,
            projectionContext,
          );
          visitTypeReferences(projection.syntax, (reference) =>
            inspectReference(reference, depth + 1),
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
      reserveInferredTypeTraversal(depth);
      visitedInferredTypes.add(type);
      const symbol = inferredTypeSymbol(type);
      if (symbol !== undefined) {
        inspectSymbol(
          symbol,
          symbol.flags & ts.SymbolFlags.Namespace ? "type-query" : "type",
          depth,
        );
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
      const projection = projectPublicDeclaration(evidence.checker, declaration, projectionContext);
      visitTypeReferences(projection.syntax, (reference) => inspectReference(reference, 1));
      for (const type of projection.inferredTypes) {
        inspectInferredType(type, 1);
      }
    }
    return supportingTypes;
  }

  function shouldExpandSupporting(declaration: ts.Declaration): boolean {
    return shouldExpandSupportingDeclaration(evidence.supportingTypeScope, declaration);
  }

  function unvisitedSupportingDeclarations(
    symbol: ts.Symbol,
    referenceKind: SupportingReferenceKind,
    visited: ReadonlySet<ts.Symbol>,
  ): readonly ts.Declaration[] {
    return visited.has(symbol) ? [] : supportingTypeDeclarations(symbol, referenceKind);
  }

  function visitTypeReferences(
    node: ts.Node,
    visitReference: (reference: SupportingReference) => void,
    depth = 0,
  ): void {
    reserveAstTraversal(depth);
    if (isPrivateDeclaration(node)) {
      return;
    }
    const reference = supportingReference(node);
    if (reference !== undefined) {
      visitReference(reference);
    }
    ts.forEachChild(node, (child) => visitTypeReferences(child, visitReference, depth + 1));
  }

  function reserveAstTraversal(depth: number): void {
    traversal.astNodeCount += 1;
    if (
      depth > MAX_SUPPORTING_TRAVERSAL_DEPTH ||
      traversal.astNodeCount > MAX_SUPPORTING_TRAVERSAL_NODES
    ) {
      throw new InspectionLimitError(
        "supporting-type-traversal",
        "Inspection exceeded its Supporting Type traversal limit.",
      );
    }
  }

  function reserveInferredTypeTraversal(depth: number): void {
    traversal.inferredTypeCount += 1;
    if (
      depth > MAX_SUPPORTING_TRAVERSAL_DEPTH ||
      traversal.inferredTypeCount > MAX_INFERRED_TYPE_NODES
    ) {
      throw new InspectionLimitError(
        "supporting-type-traversal",
        "Inspection exceeded its Supporting Type traversal limit.",
      );
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
          ? supportsTypeQuery(declaration)
          : isNamedTypeDeclarationSyntax(declaration)),
    );
    assertMergedDeclarationLimit(declarations);
    return declarations;
  }

  function supportsTypeQuery(declaration: ts.Declaration): boolean {
    const kind = declarationKind(declaration);
    if (kind === undefined) {
      return false;
    }
    return (
      DECLARATION_POLICY_BY_KIND[kind].supportsTypeQuery &&
      !declarationOwnerIsMember(evidence.checker, evidence.moduleSymbol, declaration, (depth) =>
        reserveAstTraversal(depth),
      )
    );
  }
}

export type ModuleExportInspection = ReturnType<typeof createModuleExportInspection>;

function inspectableDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly ts.Declaration[] {
  const declarations = publicDeclarations(checker, symbol.declarations ?? []).filter(
    (declaration) => declarationKind(declaration) !== undefined,
  );
  assertMergedDeclarationLimit(declarations);
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

function inspectableMemberDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly ts.Declaration[] {
  return publicMemberDeclarations(checker, symbol).filter(
    (declaration) => declarationKind(declaration) !== undefined,
  );
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
    inspectNamespaceMember(checker, symbol, member, state, depth),
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
    throw new InspectionLimitError(
      "namespace-depth",
      "Inspection exceeded its namespace traversal depth limit.",
    );
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
    throw new InspectionLimitError(
      "namespace-members",
      "Inspection exceeded its namespace member limit.",
    );
  }
}

function inspectNamespaceMember(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  member: ts.Symbol,
  state: NamespaceTraversalState,
  depth: number,
): NamespaceMemberEvidence {
  const { aliasDeclaration, targetSymbol } = resolveFocusedExportSymbol(
    checker,
    member,
    moduleSymbol,
  );
  const namespaceAliasDeclaration =
    aliasDeclaration !== undefined && ts.isNamespaceExport(aliasDeclaration)
      ? [aliasDeclaration]
      : [];
  const declarations = [
    ...namespaceAliasDeclaration,
    ...inspectableDeclarations(checker, targetSymbol),
  ];
  assertMergedDeclarationLimit(declarations);
  return {
    name: member.getName(),
    declarations,
    members: collectNamespaceMembers(checker, targetSymbol, state, depth + 1),
  };
}

function namespaceMemberDeclarations(
  members: readonly NamespaceMemberEvidence[],
): readonly ts.Declaration[] {
  return members.flatMap((member) => [
    ...member.declarations,
    ...namespaceMemberDeclarations(member.members),
  ]);
}

function declarationSpaces(declaration: ts.Declaration): readonly DeclarationSpace[] {
  const kind = declarationKind(declaration);
  return kind === undefined ? [] : DECLARATION_POLICY_BY_KIND[kind].spaces;
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
    throw new InspectionLimitError(
      "supporting-type-depth",
      "Inspection exceeded its Supporting Type depth limit.",
    );
  }
  if (supportingTypeCount >= MAX_SUPPORTING_TYPES) {
    throw new InspectionLimitError(
      "supporting-types",
      "Inspection exceeded its Supporting Type limit.",
    );
  }
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
