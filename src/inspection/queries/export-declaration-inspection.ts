import {
  isExpressionWithTypeArguments,
  isImportTypeNode,
  isTypeQueryNode,
  isTypeReferenceNode,
} from "tsrs/ast";
import type { Declaration, Node } from "tsrs/ast";
import { SymbolFlags } from "tsrs/sync";
import type { Symbol as CompilerSymbol, Type } from "tsrs/sync";

import {
  declarationsOf,
  isSourceBackedNode,
} from "#typepeek/inspection/compiler/compiler-session";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/compiler/typescript-standard-library";
import type { InspectableModuleEvidence } from "#typepeek/inspection/evidence/installed-evidence";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/model/declaration-limits";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type {
  DeclarationKind,
  InspectedDeclaration,
  SupportingType,
} from "#typepeek/inspection/model/protocol";
import type { FocusedInspectionConstruction } from "#typepeek/inspection/model/result-construction";
import {
  projectPublicDeclaration,
  renderPublicDeclaration,
} from "#typepeek/inspection/projection/declaration-projection";
import {
  inferredPublicTypeChildren,
  isNamedTypeDeclarationSyntax,
} from "#typepeek/inspection/projection/inferred-public-type";
import type { DeclarationProjectionContext } from "#typepeek/inspection/projection/inferred-public-type";
import { declarationOwnerIsMember } from "#typepeek/inspection/projection/member-type-query-projection";
import {
  declarationKind,
  declarationSupportsTypeQuery,
  isPrivateDeclaration,
} from "#typepeek/inspection/projection/public-declaration-selection";
import { shouldExpandSupportingDeclaration } from "#typepeek/inspection/projection/supporting-type-policy";
import { resolveFocusedExportTarget } from "#typepeek/inspection/queries/focused-export";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

const TYPE_QUERY = "type-query";
const MAX_DECLARATION_BYTES = 64 * 1024;
const MAX_SUPPORTING_TYPE_DEPTH = 12;
const MAX_SUPPORTING_TYPES = 96;
const MAX_SUPPORTING_TRAVERSAL_DEPTH = 64;
const MAX_SUPPORTING_TRAVERSAL_NODES = 20_000;
const MAX_INFERRED_TYPE_NODES = 4096;

type SupportingReferenceKind = "type" | "type-query";

interface SupportingReference {
  readonly kind: SupportingReferenceKind;
  readonly location: Node;
}

const inspectedDeclarationKind = function inspectedDeclarationKind(
  declaration: Declaration,
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
  type: Type
): CompilerSymbol | undefined {
  return type.getAliasSymbol() ?? type.getSymbol();
};

const ordinaryTypeReferenceLocation = function ordinaryTypeReferenceLocation(
  node: Node
): Node | undefined {
  if (isTypeReferenceNode(node)) {
    return node.typeName;
  }

  if (isExpressionWithTypeArguments(node)) {
    return node.expression;
  }

  return isImportTypeNode(node) ? node.qualifier : undefined;
};

const supportingReference = function supportingReference(
  node: Node
): SupportingReference | undefined {
  if (isTypeQueryNode(node)) {
    return { kind: TYPE_QUERY, location: node.exprName };
  }

  const location = ordinaryTypeReferenceLocation(node);

  return location === undefined ? undefined : { kind: "type", location };
};

/** Shares projection limits across declaration rendering and Supporting Type expansion. */
export const createExportDeclarationInspection =
  function createExportDeclarationInspection(
    evidence: InspectableModuleEvidence
  ) {
    const traversal = {
      astNodeCount: 0,
      inferredTypeCount: 0,
      validatedTypes: new Set<Type>(),
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

    // oxlint-disable eslint/func-style -- Function declarations preserve these correlated overload signatures.
    function inspectDeclaration(
      declaration: Declaration,
      construction: FocusedInspectionConstruction,
      kindOverride: "alias"
    ): InspectedDeclaration & {
      readonly kind: "alias";
    };
    function inspectDeclaration(
      declaration: Declaration,
      construction: FocusedInspectionConstruction,
      kindOverride?: DeclarationKind
    ): InspectedDeclaration;
    function inspectDeclaration(
      declaration: Declaration,
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

    // oxlint-enable eslint/func-style
    const supportsTypeQuery = function supportsTypeQuery(
      declaration: Declaration
    ): boolean {
      return (
        declarationSupportsTypeQuery(declaration) &&
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
      symbol: CompilerSymbol,
      referenceKind: SupportingReferenceKind
    ): readonly Declaration[] {
      // `typeof X` needs X's value declaration; ordinary type references need named type declarations.
      const declarations = (declarationsOf(symbol) ?? []).filter(
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
        symbol: CompilerSymbol,
        referenceKind: SupportingReferenceKind,
        visited: ReadonlySet<CompilerSymbol>
      ): readonly Declaration[] {
        return visited.has(symbol)
          ? []
          : supportingTypeDeclarations(symbol, referenceKind);
      };

    const shouldExpandSupporting = function shouldExpandSupporting(
      declaration: Declaration
    ): boolean {
      return shouldExpandSupportingDeclaration(
        evidence.supportingTypeScope,
        declaration
      );
    };

    const visitTypeReferences = function visitTypeReferences(
      node: Node,
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

      node.forEachChild((child) => {
        visitTypeReferences(child, visitReference, depth + 1);
      });
    };

    const inspectSupportingTypes = function inspectSupportingTypes(
      selectedSymbol: CompilerSymbol,
      rootDeclarations: readonly Declaration[],
      construction: FocusedInspectionConstruction
    ): readonly SupportingType[] {
      const supportingTypes: SupportingType[] = [];
      const visited = new Set<CompilerSymbol>([selectedSymbol]);
      const visitedInferredTypes = new Set<Type>();

      const supportingTraversal = {
        inspectInferredType: (type: Type, depth: number): void => {
          if (visitedInferredTypes.has(type)) {
            return;
          }

          reserveInferredTypeTraversal(depth);
          visitedInferredTypes.add(type);
          const symbol = inferredTypeSymbol(type);

          if (symbol !== undefined) {
            supportingTraversal.inspectSymbol(
              symbol,
              bitwiseAnd(symbol.flags, SymbolFlags.Namespace)
                ? TYPE_QUERY
                : "type",
              depth
            );
          }

          for (const childType of inferredPublicTypeChildren(
            evidence.checker,
            type
          )) {
            supportingTraversal.inspectInferredType(childType, depth + 1);
          }
        },
        inspectReference: (
          reference: SupportingReference,
          depth: number
        ): void => {
          // Synthesized names have no binder location. Their dependencies are
          // traversed through the checker types retained by the projection.
          if (!isSourceBackedNode(reference.location)) {
            return;
          }

          const referenced = evidence.checker.getSymbolAtLocation(
            reference.location
          );

          if (referenced === undefined) {
            return;
          }

          supportingTraversal.inspectSymbol(referenced, reference.kind, depth);
        },
        inspectSymbol: (
          symbol: CompilerSymbol,
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
              resolvedSymbol.name,
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
              supportingTraversal.inspectReference(reference, depth + 1);
            });

            for (const type of projection.inferredTypes) {
              supportingTraversal.inspectInferredType(type, depth + 1);
            }
          }

          return true;
        },
      };

      for (const declaration of rootDeclarations) {
        const projection = projectPublicDeclaration(
          evidence.checker,
          declaration,
          projectionContext
        );

        visitTypeReferences(projection.syntax, (reference) => {
          supportingTraversal.inspectReference(reference, 1);
        });

        for (const type of projection.inferredTypes) {
          supportingTraversal.inspectInferredType(type, 1);
        }
      }

      return supportingTypes;
    };

    return { inspectDeclaration, inspectSupportingTypes };
  };
