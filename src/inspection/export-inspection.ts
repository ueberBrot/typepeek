import ts from "@typescript/typescript6";

import { MAX_NAMESPACE_DEPTH } from "#typepeek/inspection/budget-policy";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/declaration-limits";
import type { DeclarationProjectionContext } from "#typepeek/inspection/declaration-projection";
import {
  declarationOwnerIsMember,
  inferredPublicTypeChildren,
  isNamedTypeDeclarationSyntax,
  isPrivateDeclaration,
  projectPublicDeclaration,
  publicDeclarations,
  renderPublicDeclaration,
} from "#typepeek/inspection/declaration-projection";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import type {
  AliasDeclaration,
  FocusedExportResolution,
} from "#typepeek/inspection/focused-export";
import {
  resolveFocusedExport,
  resolveFocusedExportSymbol,
  resolveFocusedExportTarget,
} from "#typepeek/inspection/focused-export";
import type { InspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import type { PublicMemberPathResolution } from "#typepeek/inspection/member-inspection";
import {
  discoverPublicMembers,
  publicMemberDeclarations,
  resolvePublicMemberPath,
} from "#typepeek/inspection/member-inspection";
import type { MemberPath } from "#typepeek/inspection/member-path";
import { MAX_MEMBER_PATH_SEGMENTS } from "#typepeek/inspection/member-path";
import { inspectPackageDocumentation } from "#typepeek/inspection/package-documentation";
import type {
  DeclarationInspection,
  DeclarationKind,
  DeclarationSpace,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectedModuleExport,
  MemberDiscovery,
  MemberInspection,
  SupportingType,
} from "#typepeek/inspection/protocol";
import type {
  FocusedInspectionConstruction,
  InspectionResultConstruction,
} from "#typepeek/inspection/result-construction";
import { inspectResolvedExportSignatures } from "#typepeek/inspection/signature-inspection";
import { shouldExpandSupportingDeclaration } from "#typepeek/inspection/supporting-type-policy";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/typescript-standard-library";
import { bitwiseAnd } from "#typepeek/integer-bits";

const TYPE_QUERY = "type-query";
const MAX_DECLARATION_BYTES = 64 * 1024;
const MAX_NAMESPACE_MEMBERS = 128;
const MAX_SUPPORTING_TYPE_DEPTH = 12;
const MAX_SUPPORTING_TYPES = 96;
const MAX_SUPPORTING_TRAVERSAL_DEPTH = 64;
const MAX_SUPPORTING_TRAVERSAL_NODES = 20_000;
const MAX_INFERRED_TYPE_NODES = 4096;

const DECLARATION_KIND_BY_SYNTAX_KIND = new Map<ts.SyntaxKind, DeclarationKind>(
  [
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
  ]
);

const DECLARATION_POLICY_BY_KIND: Readonly<
  Record<
    DeclarationKind,
    {
      readonly spaces: readonly DeclarationSpace[];
      readonly supportsTypeQuery: boolean;
    }
  >
> = {
  accessor: { spaces: ["value"], supportsTypeQuery: false },
  alias: { spaces: [], supportsTypeQuery: false },
  class: { spaces: ["type", "value"], supportsTypeQuery: true },
  constructor: { spaces: ["value"], supportsTypeQuery: false },
  enum: { spaces: ["type", "value"], supportsTypeQuery: true },
  "enum-member": { spaces: ["value"], supportsTypeQuery: false },
  function: { spaces: ["value"], supportsTypeQuery: true },
  interface: { spaces: ["type"], supportsTypeQuery: false },
  method: { spaces: ["value"], supportsTypeQuery: false },
  namespace: { spaces: ["value", "namespace"], supportsTypeQuery: true },
  property: { spaces: ["value"], supportsTypeQuery: false },
  "type-alias": { spaces: ["type"], supportsTypeQuery: false },
  variable: { spaces: ["value"], supportsTypeQuery: true },
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

export type FocusedMemberFailureStatus =
  | "ambiguous-member"
  | "export-not-found"
  | "member-not-found"
  | "unsupported-member";

export type FocusedMemberInspection =
  | {
      readonly status: "success";
      readonly result: MemberInspection;
    }
  | {
      readonly status: FocusedMemberFailureStatus;
    };

const declarationKind = function declarationKind(
  declaration: ts.Declaration
): DeclarationKind | undefined {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind);
};

const inspectedDeclarationKind = function inspectedDeclarationKind(
  declaration: ts.Declaration,
  kindOverride: DeclarationKind | undefined
): DeclarationKind {
  const kind = kindOverride ?? declarationKind(declaration);

  if (kind === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export contains an unsupported declaration kind."
    );
  }

  return kind;
};

const selectedDeclarationIsUnsupported =
  function selectedDeclarationIsUnsupported(
    declarations: readonly ts.Declaration[],
    aliasDeclaration: AliasDeclaration | undefined
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
  };

const assertSupportedSelectedDeclarationKind =
  function assertSupportedSelectedDeclarationKind(
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
    aliasDeclaration: AliasDeclaration | undefined
  ): void {
    const declarations = publicDeclarations(checker, symbol.declarations ?? []);

    if (selectedDeclarationIsUnsupported(declarations, aliasDeclaration)) {
      throw new UnsupportedInspectionError(
        "The selected Module Export contains an unsupported declaration kind."
      );
    }
  };

const assertNamespaceTraversalAllowed =
  function assertNamespaceTraversalAllowed(
    symbol: ts.Symbol,
    state: NamespaceTraversalState,
    depth: number
  ): void {
    if (depth > MAX_NAMESPACE_DEPTH) {
      throw new InspectionLimitError(
        "namespace-depth",
        "Inspection exceeded its namespace traversal depth limit."
      );
    }

    if (state.visited.has(symbol)) {
      throw new UnsupportedInspectionError(
        "The selected Module Export contains a circular namespace re-export."
      );
    }
  };

const reserveNamespaceMembers = function reserveNamespaceMembers(
  state: NamespaceTraversalState,
  count: number
): void {
  state.memberCount += count;

  if (state.memberCount > MAX_NAMESPACE_MEMBERS) {
    throw new InspectionLimitError(
      "namespace-members",
      "Inspection exceeded its namespace member limit."
    );
  }
};

const inspectableDeclarations = function inspectableDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): readonly ts.Declaration[] {
  const declarations = publicDeclarations(
    checker,
    symbol.declarations ?? []
  ).filter((declaration) => declarationKind(declaration) !== undefined);

  assertMergedDeclarationLimit(declarations);

  return declarations;
};

const namespaceInspection = {
  collectNamespaceMembers(
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
    state: NamespaceTraversalState,
    depth: number
  ): readonly NamespaceMemberEvidence[] {
    if (bitwiseAnd(symbol.flags, ts.SymbolFlags.Module) === 0) {
      return [];
    }

    assertNamespaceTraversalAllowed(symbol, state, depth);
    // `visited` tracks the current path rather than all previously seen symbols,
    // allowing shared namespaces in sibling branches while rejecting cycles.
    state.visited.add(symbol);
    const exportedMembers = checker.getExportsOfModule(symbol);
    reserveNamespaceMembers(state, exportedMembers.length);

    const members = exportedMembers.map((member) =>
      namespaceInspection.inspectNamespaceMember(
        checker,
        symbol,
        member,
        state,
        depth
      )
    );

    state.visited.delete(symbol);

    return members;
  },
  inspectNamespaceMember(
    checker: ts.TypeChecker,
    moduleSymbol: ts.Symbol,
    member: ts.Symbol,
    state: NamespaceTraversalState,
    depth: number
  ): NamespaceMemberEvidence {
    const { aliasDeclaration, targetSymbol } = resolveFocusedExportSymbol(
      checker,
      member,
      moduleSymbol
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
      declarations,
      members: namespaceInspection.collectNamespaceMembers(
        checker,
        targetSymbol,
        state,
        depth + 1
      ),
      name: member.getName(),
    };
  },
};

const inspectNamespaceMemberEvidence = function inspectNamespaceMemberEvidence(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): readonly NamespaceMemberEvidence[] {
  return namespaceInspection.collectNamespaceMembers(
    checker,
    symbol,
    {
      memberCount: 0,
      visited: new Set(),
    },
    0
  );
};

const inspectableMemberDeclarations = function inspectableMemberDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): readonly ts.Declaration[] {
  return publicMemberDeclarations(checker, symbol).filter(
    (declaration) => declarationKind(declaration) !== undefined
  );
};

const declarationSpaces = function declarationSpaces(
  declaration: ts.Declaration
): readonly DeclarationSpace[] {
  const kind = declarationKind(declaration);

  return kind === undefined ? [] : DECLARATION_POLICY_BY_KIND[kind].spaces;
};

const assertSupportingTypeBudget = function assertSupportingTypeBudget(
  depth: number,
  supportingTypeCount: number
): void {
  if (depth > MAX_SUPPORTING_TYPE_DEPTH) {
    throw new InspectionLimitError(
      "supporting-type-depth",
      "Inspection exceeded its Supporting Type depth limit."
    );
  }

  if (supportingTypeCount >= MAX_SUPPORTING_TYPES) {
    throw new InspectionLimitError(
      "supporting-types",
      "Inspection exceeded its Supporting Type limit."
    );
  }
};

const inferredTypeSymbol = function inferredTypeSymbol(
  type: ts.Type
): ts.Symbol | undefined {
  return type.aliasSymbol ?? type.getSymbol();
};

const namespaceMemberDeclarations = function namespaceMemberDeclarations(
  members: readonly NamespaceMemberEvidence[]
): readonly ts.Declaration[] {
  return members.flatMap((member) => [
    ...member.declarations,
    ...namespaceMemberDeclarations(member.members),
  ]);
};

const supportingRootDeclarations = function supportingRootDeclarations(
  checker: ts.TypeChecker,
  selectedSymbol: ts.Symbol,
  namespaceMembers: readonly NamespaceMemberEvidence[]
): readonly ts.Declaration[] {
  return [
    ...inspectableDeclarations(checker, selectedSymbol),
    ...namespaceMemberDeclarations(namespaceMembers),
  ];
};

const ordinaryTypeReferenceLocation = function ordinaryTypeReferenceLocation(
  node: ts.Node
): ts.Node | undefined {
  if (ts.isTypeReferenceNode(node)) {
    return node.typeName;
  }

  if (ts.isExpressionWithTypeArguments(node)) {
    return node.expression;
  }

  return ts.isImportTypeNode(node) ? node.qualifier : undefined;
};

const supportingReference = function supportingReference(
  node: ts.Node
): SupportingReference | undefined {
  if (ts.isTypeQueryNode(node)) {
    return { kind: TYPE_QUERY, location: node.exprName };
  }

  const location = ordinaryTypeReferenceLocation(node);

  return location === undefined ? undefined : { kind: "type", location };
};

export const createModuleExportInspection =
  function createModuleExportInspection(
    evidence: InspectableModuleEvidence,
    constructionOwner: InspectionResultConstruction
  ) {
    const traversal = {
      astNodeCount: 0,
      inferredTypeCount: 0,
      validatedTypes: new Set<ts.Type>(),
    };

    const reserveAstTraversal = function reserveAstTraversal(
      depth: number
    ): void {
      traversal.astNodeCount += 1;

      if (
        depth > MAX_SUPPORTING_TRAVERSAL_DEPTH ||
        traversal.astNodeCount > MAX_SUPPORTING_TRAVERSAL_NODES
      ) {
        throw new InspectionLimitError(
          "supporting-type-traversal",
          "Inspection exceeded its Supporting Type traversal limit."
        );
      }
    };

    const reserveInferredTypeTraversal = function reserveInferredTypeTraversal(
      depth: number
    ): void {
      traversal.inferredTypeCount += 1;

      if (
        depth > MAX_SUPPORTING_TRAVERSAL_DEPTH ||
        traversal.inferredTypeCount > MAX_INFERRED_TYPE_NODES
      ) {
        throw new InspectionLimitError(
          "supporting-type-traversal",
          "Inspection exceeded its Supporting Type traversal limit."
        );
      }
    };

    const projectionContext: DeclarationProjectionContext = {
      moduleSymbol: evidence.moduleSymbol,
      reserveTraversal: reserveAstTraversal,
      reserveTypeTraversal: reserveInferredTypeTraversal,
      validatedTypes: traversal.validatedTypes,
    };

    const resolveFocusedMember = function resolveFocusedMember(
      exportName: string,
      memberPath: MemberPath
    ):
      | PublicMemberPathResolution
      | {
          readonly status: "export-not-found";
        } {
      const resolution = resolveFocusedExport(
        evidence.checker,
        evidence.moduleSymbol,
        exportName
      );

      return resolution === undefined
        ? { status: "export-not-found" }
        : resolvePublicMemberPath(
            evidence.checker,
            resolution.targetSymbol,
            memberPath,
            constructionOwner
          );
    };

    const discoverFocusedModuleExportMembers =
      function discoverFocusedModuleExportMembers(
        exportName: string,
        memberPath: MemberPath,
        query: string | undefined
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
          constructionOwner
        );

        if (
          memberPath.length === MAX_MEMBER_PATH_SEGMENTS &&
          discovery.totalMembers > 0
        ) {
          throw new UnsupportedInspectionError(
            "Member Discovery cannot select children beyond the Member path depth limit."
          );
        }

        return {
          result: constructionOwner.memberDiscovery(
            exportName,
            memberPath,
            query,
            discovery.totalMembers,
            discovery.members
          ),
          status: "success",
        };
      };

    const readFocusedDeclarationEvidence =
      function readFocusedDeclarationEvidence(
        exportName: string
      ): FocusedDeclarationEvidence | undefined {
        const resolution = resolveFocusedExport(
          evidence.checker,
          evidence.moduleSymbol,
          exportName
        );

        if (resolution === undefined) {
          return undefined;
        }

        const { targetSymbol, aliasDeclaration, spaces } = resolution;
        assertSupportedSelectedDeclarationKind(
          evidence.checker,
          targetSymbol,
          aliasDeclaration
        );

        return {
          construction: constructionOwner.focused(),
          namespaceMembers: spaces.includes("namespace")
            ? inspectNamespaceMemberEvidence(evidence.checker, targetSymbol)
            : [],
          resolution,
        };
      };

    // oxlint-disable eslint/func-style -- Function declarations preserve these correlated overload signatures.
    function inspectDeclaration(
      declaration: ts.Declaration,
      construction: FocusedInspectionConstruction,
      kindOverride: "alias"
    ): InspectedDeclaration & {
      readonly kind: "alias";
    };
    function inspectDeclaration(
      declaration: ts.Declaration,
      construction: FocusedInspectionConstruction,
      kindOverride?: DeclarationKind
    ): InspectedDeclaration;
    function inspectDeclaration(
      declaration: ts.Declaration,
      construction: FocusedInspectionConstruction,
      kindOverride?: DeclarationKind
    ): InspectedDeclaration {
      const sourceFile = declaration.getSourceFile();

      const start = sourceFile.getLineAndCharacterOfPosition(
        declaration.getStart(sourceFile, false)
      );

      const text = renderPublicDeclaration(
        evidence.checker,
        declaration,
        projectionContext
      );

      if (Buffer.byteLength(text) > MAX_DECLARATION_BYTES) {
        throw new InspectionLimitError(
          "declaration-output",
          "Inspection exceeded its declaration output limit."
        );
      }

      const kind = inspectedDeclarationKind(declaration, kindOverride);
      const provenance = evidence.declarationProvenance(sourceFile.fileName);

      const inspectedDeclaration: InspectedDeclaration = {
        kind,
        provenance: {
          ...provenance,
          column: start.character + 1,
          line: start.line + 1,
        },
        text,
      };

      return construction.declaration(inspectedDeclaration);
    }

    const inspectAlias = function inspectAlias(
      resolution: FocusedExportResolution,
      construction: FocusedInspectionConstruction
    ): ExportAlias | undefined {
      const { aliasDeclaration } = resolution;

      if (
        aliasDeclaration === undefined ||
        resolution.aliasTargetName === undefined
      ) {
        return undefined;
      }

      const declaration = inspectDeclaration(
        aliasDeclaration,
        construction,
        "alias"
      );

      return construction.alias(resolution.aliasTargetName, declaration);
    };

    const inspectNamespaceMembers = function inspectNamespaceMembers(
      members: readonly NamespaceMemberEvidence[],
      construction: FocusedInspectionConstruction
    ): readonly ExportNamespaceMember[] {
      return members.map((member) => {
        const declarations = member.declarations.map((declaration) =>
          inspectDeclaration(declaration, construction)
        );

        const childMembers = inspectNamespaceMembers(
          member.members,
          construction
        );

        return construction.namespaceMember(
          member.name,
          declarations,
          childMembers
        );
      });
    };

    const inspectedDeclarations = function inspectedDeclarations(
      declarations: readonly ts.Declaration[],
      aliasDeclaration: AliasDeclaration | undefined,
      construction: FocusedInspectionConstruction
    ): readonly InspectedDeclaration[] {
      if (declarations.length > 0) {
        return declarations.map((declaration) =>
          inspectDeclaration(declaration, construction)
        );
      }

      return aliasDeclaration === undefined
        ? []
        : [inspectDeclaration(aliasDeclaration, construction, "alias")];
    };

    const inspectDeclarationSpaces = function inspectDeclarationSpaces({
      resolution,
      namespaceMembers,
      construction,
    }: FocusedDeclarationEvidence): readonly ExportDeclarationSpace[] {
      const { targetSymbol, aliasDeclaration, spaces } = resolution;

      const declarations = inspectableDeclarations(
        evidence.checker,
        targetSymbol
      );

      return spaces.map((space): ExportDeclarationSpace => {
        if (space === "namespace") {
          return construction.namespaceSpace(
            inspectNamespaceMembers(namespaceMembers, construction)
          );
        }

        return construction.declarationSpace(
          space,
          inspectedDeclarations(
            declarations.filter((declaration) =>
              declarationSpaces(declaration).includes(space)
            ),
            aliasDeclaration,
            construction
          )
        );
      });
    };

    /** Inspects only one Module Export's declarations, without signatures or Supporting Types. */
    const inspectFocusedModuleExportDeclarations =
      function inspectFocusedModuleExportDeclarations(
        exportName: string
      ): DeclarationInspection | undefined {
        const focused = readFocusedDeclarationEvidence(exportName);

        if (focused === undefined) {
          return undefined;
        }

        const alias = inspectAlias(focused.resolution, focused.construction);

        const moduleExport = focused.construction.moduleExportDeclarations({
          name: focused.resolution.exportedSymbol.getName(),
          ...(alias !== undefined && { alias }),
          spaces: inspectDeclarationSpaces(focused),
        });

        return focused.construction.declarationResult(moduleExport);
      };

    const inspectModuleExport = function inspectModuleExport(
      focused: FocusedDeclarationEvidence
    ): InspectedModuleExport {
      const { resolution, construction } = focused;
      const alias = inspectAlias(resolution, construction);
      const focusedDeclarationSpaces = inspectDeclarationSpaces(focused);

      const signatures = inspectResolvedExportSignatures(
        evidence.checker,
        resolution,
        (value) => construction.signature(value)
      );

      return construction.moduleExport({
        name: resolution.exportedSymbol.getName(),
        ...(alias !== undefined && { alias }),
        signatures,
        spaces: focusedDeclarationSpaces,
      });
    };

    const supportsTypeQuery = function supportsTypeQuery(
      declaration: ts.Declaration
    ): boolean {
      const kind = declarationKind(declaration);

      if (kind === undefined) {
        return false;
      }

      return (
        DECLARATION_POLICY_BY_KIND[kind].supportsTypeQuery &&
        !declarationOwnerIsMember(
          evidence.checker,
          evidence.moduleSymbol,
          declaration,
          (depth) => {
            reserveAstTraversal(depth);
          }
        )
      );
    };

    const supportingTypeDeclarations = function supportingTypeDeclarations(
      symbol: ts.Symbol,
      referenceKind: SupportingReferenceKind
    ): readonly ts.Declaration[] {
      // `typeof X` needs X's value declaration; ordinary type references need named type declarations.
      const declarations = (symbol.declarations ?? []).filter(
        (declaration) =>
          !isTypeScriptStandardLibraryDeclaration(
            declaration.getSourceFile().fileName
          ) &&
          (referenceKind === TYPE_QUERY
            ? supportsTypeQuery(declaration)
            : isNamedTypeDeclarationSyntax(declaration))
      );

      assertMergedDeclarationLimit(declarations);

      return declarations;
    };

    const unvisitedSupportingDeclarations =
      function unvisitedSupportingDeclarations(
        symbol: ts.Symbol,
        referenceKind: SupportingReferenceKind,
        visited: ReadonlySet<ts.Symbol>
      ): readonly ts.Declaration[] {
        return visited.has(symbol)
          ? []
          : supportingTypeDeclarations(symbol, referenceKind);
      };

    const shouldExpandSupporting = function shouldExpandSupporting(
      declaration: ts.Declaration
    ): boolean {
      return shouldExpandSupportingDeclaration(
        evidence.supportingTypeScope,
        declaration
      );
    };

    const visitTypeReferences = function visitTypeReferences(
      node: ts.Node,
      visitReference: (reference: SupportingReference) => void,
      depth = 0
    ): void {
      reserveAstTraversal(depth);

      if (isPrivateDeclaration(node)) {
        return;
      }

      const reference = supportingReference(node);

      if (reference !== undefined) {
        visitReference(reference);
      }

      ts.forEachChild(node, (child) => {
        visitTypeReferences(child, visitReference, depth + 1);
      });
    };

    const inspectSupportingTypes = function inspectSupportingTypes(
      selectedSymbol: ts.Symbol,
      namespaceMembers: readonly NamespaceMemberEvidence[],
      construction: FocusedInspectionConstruction
    ): readonly SupportingType[] {
      const supportingTypes: SupportingType[] = [];
      const visited = new Set<ts.Symbol>([selectedSymbol]);
      const visitedInferredTypes = new Set<ts.Type>();

      const supportingTypeTraversal2 = {
        inspectInferredType: (type: ts.Type, depth: number): void => {
          if (visitedInferredTypes.has(type)) {
            return;
          }

          reserveInferredTypeTraversal(depth);
          visitedInferredTypes.add(type);
          const symbol = inferredTypeSymbol(type);

          if (symbol !== undefined) {
            supportingTypeTraversal2.inspectSymbol(
              symbol,
              bitwiseAnd(symbol.flags, ts.SymbolFlags.Namespace)
                ? TYPE_QUERY
                : "type",
              depth
            );
          }

          for (const childType of inferredPublicTypeChildren(
            evidence.checker,
            type
          )) {
            supportingTypeTraversal2.inspectInferredType(childType, depth + 1);
          }
        },
        inspectReference: (
          reference: SupportingReference,
          depth: number
        ): void => {
          const referenced = evidence.checker.getSymbolAtLocation(
            reference.location
          );

          if (referenced === undefined) {
            return;
          }

          supportingTypeTraversal2.inspectSymbol(
            referenced,
            reference.kind,
            depth
          );
        },
        inspectSymbol: (
          symbol: ts.Symbol,
          referenceKind: SupportingReferenceKind,
          depth: number
        ): boolean => {
          const resolvedSymbol = resolveFocusedExportTarget(
            evidence.checker,
            symbol
          );

          const declarations = unvisitedSupportingDeclarations(
            resolvedSymbol,
            referenceKind,
            visited
          );

          if (declarations.length === 0) {
            return false;
          }

          assertSupportingTypeBudget(depth, supportingTypes.length);
          visited.add(resolvedSymbol);

          const inspectedSupportingDeclarations = declarations.map(
            (declaration) => inspectDeclaration(declaration, construction)
          );

          supportingTypes.push(
            construction.supportingType(
              resolvedSymbol.getName(),
              inspectedSupportingDeclarations
            )
          );

          for (const supportingDeclaration of declarations.filter(
            shouldExpandSupporting
          )) {
            const projection = projectPublicDeclaration(
              evidence.checker,
              supportingDeclaration,
              projectionContext
            );

            visitTypeReferences(projection.syntax, (reference) => {
              supportingTypeTraversal2.inspectReference(reference, depth + 1);
            });

            for (const type of projection.inferredTypes) {
              supportingTypeTraversal2.inspectInferredType(type, depth + 1);
            }
          }

          return true;
        },
      };

      for (const declaration of supportingRootDeclarations(
        evidence.checker,
        selectedSymbol,
        namespaceMembers
      )) {
        const projection = projectPublicDeclaration(
          evidence.checker,
          declaration,
          projectionContext
        );

        visitTypeReferences(projection.syntax, (reference) => {
          supportingTypeTraversal2.inspectReference(reference, 1);
        });

        for (const type of projection.inferredTypes) {
          supportingTypeTraversal2.inspectInferredType(type, 1);
        }
      }

      return supportingTypes;
    };

    // oxlint-enable eslint/func-style
    /**
     * Produces a bounded Export Inspection from one Inspectable Module backed by
     * Installed Evidence. Returns `undefined` only when the named Module Export is
     * absent; unsupported declaration shapes and exhausted budgets use typed errors.
     */
    const inspectFocusedModuleExport = function inspectFocusedModuleExport(
      exportName: string
    ): ExportInspection | undefined {
      const focused = readFocusedDeclarationEvidence(exportName);

      if (focused === undefined) {
        return undefined;
      }

      const packageDocumentationEvidence = inspectPackageDocumentation(
        evidence.checker,
        focused.resolution.exportedSymbol,
        focused.resolution.targetSymbol,
        focused.resolution.aliasDeclaration
      );

      const packageDocumentation =
        packageDocumentationEvidence === undefined
          ? undefined
          : focused.construction.documentation(packageDocumentationEvidence);

      const moduleExport = inspectModuleExport(focused);

      const supportingTypes = inspectSupportingTypes(
        focused.resolution.targetSymbol,
        focused.namespaceMembers,
        focused.construction
      );

      return focused.construction.exportResult(
        moduleExport,
        supportingTypes,
        packageDocumentation
      );
    };

    const inspectFocusedModuleExportMember =
      function inspectFocusedModuleExportMember(
        exportName: string,
        memberPath: MemberPath
      ): FocusedMemberInspection {
        const memberResolution = resolveFocusedMember(exportName, memberPath);

        if (memberResolution.status !== "success") {
          return { status: memberResolution.status };
        }

        const memberDeclarations = inspectableMemberDeclarations(
          evidence.checker,
          memberResolution.symbol
        );

        if (memberDeclarations.length === 0) {
          return { status: "unsupported-member" };
        }

        const construction = constructionOwner.focused();

        const declarations = memberDeclarations.map((declaration) =>
          inspectDeclaration(declaration, construction)
        );

        return {
          result: construction.memberResult(
            exportName,
            memberPath,
            declarations
          ),
          status: "success",
        };
      };

    return {
      discoverMembers: discoverFocusedModuleExportMembers,
      inspectDeclarations: inspectFocusedModuleExportDeclarations,
      inspectExport: inspectFocusedModuleExport,
      inspectMember: inspectFocusedModuleExportMember,
    };
  };

export type ModuleExportInspection = ReturnType<
  typeof createModuleExportInspection
>;
