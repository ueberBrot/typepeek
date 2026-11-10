import {
  isEnumMember,
  isFunctionLikeDeclaration,
  isIdentifier,
  isModuleBlock,
  isModuleDeclaration,
  isParameterDeclaration,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isSourceFile,
  isTypeAliasDeclaration,
  isTypeQueryNode,
  isVariableDeclaration,
  SyntaxKind,
  visitEachChild,
} from "tsrs/ast";
import type { Declaration, Node, TypeNode, TypeQueryNode } from "tsrs/ast";
import { NodeBuilderFlags, SymbolFlags } from "tsrs/sync";
import type { Checker, Symbol as CompilerSymbol, Type } from "tsrs/sync";

import { aliasedSymbol } from "#typepeek/inspection/compiler/compiler-queries";
import {
  declarationsOf,
  isSourceBackedNode,
} from "#typepeek/inspection/compiler/compiler-session";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/compiler/typescript-standard-library";
import { UnsupportedInspectionError } from "#typepeek/inspection/model/errors";
import {
  assertNoImplementationLocalType,
  assertReliableInferredType,
  isNamedTypeDeclarationSyntax,
} from "#typepeek/inspection/projection/inferred-public-type";
import type { DeclarationProjectionContext } from "#typepeek/inspection/projection/inferred-public-type";
import { isWellKnownSymbolMemberName } from "#typepeek/inspection/projection/well-known-symbol";
import { bitwiseAnd, bitwiseOr } from "#typepeek/shared/integer-bits";

const UNREPRESENTABLE_MEMBER_MESSAGE =
  "A Member type query could not be represented independently.";

const MEMBER_TYPE_QUERY_FLAGS = bitwiseOr(
  bitwiseOr(
    NodeBuilderFlags.NoTruncation,
    NodeBuilderFlags.UseStructuralFallback
  ),
  NodeBuilderFlags.WriteClassExpressionAsTypeLiteral
);

const MEMBER_CONTAINER_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.TypeLiteral,
]);

const resolvedSymbolAtLocation = function resolvedSymbolAtLocation(
  checker: Checker,
  node: Node
): CompilerSymbol | undefined {
  if (!isSourceBackedNode(node)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(node);

  return symbol !== undefined &&
    bitwiseAnd(symbol.flags, SymbolFlags.Alias) !== 0
    ? aliasedSymbol(checker, symbol)
    : symbol;
};

const declarationsAreStandardLibrary = function declarationsAreStandardLibrary(
  declarations: readonly Declaration[]
): boolean {
  return (
    declarations.length > 0 &&
    declarations.every((declaration) =>
      isTypeScriptStandardLibraryDeclaration(
        declaration.getSourceFile().fileName
      )
    )
  );
};

const isWellKnownSymbolTypeQuery = function isWellKnownSymbolTypeQuery(
  checker: Checker,
  node: TypeQueryNode
): boolean {
  if (
    !isQualifiedName(node.exprName) ||
    !isIdentifier(node.exprName.left) ||
    node.exprName.left.text !== "Symbol" ||
    !isWellKnownSymbolMemberName(node.exprName.right.text)
  ) {
    return false;
  }

  const rootSymbol = resolvedSymbolAtLocation(checker, node.exprName.left);

  return (
    rootSymbol === undefined ||
    declarationsAreStandardLibrary(declarationsOf(rootSymbol) ?? [])
  );
};

/** Identifies declarations owned by a Member rather than the selected Inspectable Module. */
export const declarationOwnerIsMember = function declarationOwnerIsMember(
  checker: Checker,
  moduleSymbol: CompilerSymbol,
  declaration: Declaration,
  reserveTraversal: (depth: number) => void
): boolean {
  let ancestor = declaration.parent;

  for (
    let depth = 0;
    ancestor !== undefined;
    depth += 1, ancestor = ancestor.parent
  ) {
    reserveTraversal(depth);

    if (isSourceFile(ancestor)) {
      return false;
    }

    if (isModuleBlock(ancestor)) {
      return (
        checker.getSymbolAtLocation(
          isModuleDeclaration(ancestor.parent)
            ? ancestor.parent.name
            : ancestor.parent
        ) !== moduleSymbol
      );
    }

    if (MEMBER_CONTAINER_KINDS.has(ancestor.kind)) {
      return true;
    }
  }

  return false;
};

const isMemberTypeQuery = function isMemberTypeQuery(
  checker: Checker,
  node: Node,
  context: DeclarationProjectionContext
): node is TypeQueryNode {
  if (!isTypeQueryNode(node)) {
    return false;
  }

  if (isWellKnownSymbolTypeQuery(checker, node)) {
    return false;
  }

  const symbol = resolvedSymbolAtLocation(checker, node.exprName);
  const declarations = declarationsOf(symbol) ?? [];

  if (
    declarations.some(
      (declaration) =>
        !isTypeScriptStandardLibraryDeclaration(
          declaration.getSourceFile().fileName
        ) &&
        declarationOwnerIsMember(
          checker,
          context.moduleSymbol,
          declaration,
          context.reserveTraversal
        )
    )
  ) {
    return true;
  }

  return (
    isQualifiedName(node.exprName) &&
    !declarationsAreStandardLibrary(declarations)
  );
};

const explicitDeclarationType = function explicitDeclarationType(
  declaration: Declaration
): TypeNode | undefined {
  if (
    isFunctionLikeDeclaration(declaration) ||
    isVariableDeclaration(declaration) ||
    isPropertyDeclaration(declaration)
  ) {
    return declaration.type;
  }

  if (
    isPropertySignatureDeclaration(declaration) ||
    isParameterDeclaration(declaration) ||
    isTypeAliasDeclaration(declaration)
  ) {
    return declaration.type;
  }

  return undefined;
};

const standardLibraryTypeQueryIsAuthoritative =
  function standardLibraryTypeQueryIsAuthoritative(
    checker: Checker,
    typeQuery: TypeQueryNode
  ): boolean {
    const typeSymbol = resolvedSymbolAtLocation(checker, typeQuery.exprName);

    return (
      declarationsAreStandardLibrary(declarationsOf(typeSymbol) ?? []) ||
      isWellKnownSymbolTypeQuery(checker, typeQuery)
    );
  };

const exactStandardLibraryMemberTypeQuery =
  function exactStandardLibraryMemberTypeQuery(
    checker: Checker,
    query: TypeQueryNode
  ): TypeQueryNode | undefined {
    const symbol = resolvedSymbolAtLocation(checker, query.exprName);

    return declarationsOf(symbol)
      ?.map(explicitDeclarationType)
      .find(
        (typeNode): typeNode is TypeQueryNode =>
          typeNode !== undefined &&
          isTypeQueryNode(typeNode) &&
          standardLibraryTypeQueryIsAuthoritative(checker, typeNode)
      );
  };

export const collectMemberTypeQueryTypes = function collectMemberTypeQueryTypes(
  checker: Checker,
  node: Node,
  types: Type[],
  context: DeclarationProjectionContext,
  depth: number
): void {
  context.reserveTraversal(depth);

  if (isMemberTypeQuery(checker, node, context)) {
    if (exactStandardLibraryMemberTypeQuery(checker, node) === undefined) {
      types.push(checker.getTypeAtLocation(node.exprName));
    }

    return;
  }

  node.forEachChild((child) => {
    collectMemberTypeQueryTypes(checker, child, types, context, depth + 1);
  });
};

const assertMemberTypeSymbolIsRepresentable =
  function assertMemberTypeSymbolIsRepresentable(
    checker: Checker,
    type: Type,
    context: DeclarationProjectionContext
  ): void {
    const symbol = type.getAliasSymbol() ?? type.getSymbol();

    if (
      symbol !== undefined &&
      declarationsOf(symbol).some(
        (declaration) =>
          (isNamedTypeDeclarationSyntax(declaration) ||
            isEnumMember(declaration)) &&
          declarationOwnerIsMember(
            checker,
            context.moduleSymbol,
            declaration,
            context.reserveTraversal
          )
      )
    ) {
      throw new UnsupportedInspectionError(UNREPRESENTABLE_MEMBER_MESSAGE);
    }
  };

const declarationHasExplicitType = function declarationHasExplicitType(
  declaration: Declaration
): boolean {
  return (
    explicitDeclarationType(declaration) !== undefined ||
    isEnumMember(declaration)
  );
};

const memberTypeHasExplicitDeclaration =
  function memberTypeHasExplicitDeclaration(
    checker: Checker,
    query: TypeQueryNode
  ): boolean {
    const symbol = resolvedSymbolAtLocation(checker, query.exprName);

    return declarationsOf(symbol).some(declarationHasExplicitType);
  };

const containsTypeQuery = function containsTypeQuery(
  node: Node,
  context: DeclarationProjectionContext,
  allowsStandardLibraryTypeQuery: boolean,
  depth: number
): boolean {
  context.reserveTraversal(depth);

  if (isTypeQueryNode(node)) {
    return !allowsStandardLibraryTypeQuery;
  }

  let found = false;
  node.forEachChild((child) => {
    found ||= containsTypeQuery(
      child,
      context,
      allowsStandardLibraryTypeQuery,
      depth + 1
    );
  });

  return found;
};

const resolvedMemberTypeNode = function resolvedMemberTypeNode(
  checker: Checker,
  query: TypeQueryNode,
  context: DeclarationProjectionContext
): TypeNode {
  const exactStandardLibraryQuery = exactStandardLibraryMemberTypeQuery(
    checker,
    query
  );

  if (exactStandardLibraryQuery !== undefined) {
    return exactStandardLibraryQuery;
  }

  const type = checker.getTypeAtLocation(query.exprName);
  assertNoImplementationLocalType(checker, type, context);
  assertMemberTypeSymbolIsRepresentable(checker, type, context);
  const typeNode = checker.typeToTypeNode(type, query, MEMBER_TYPE_QUERY_FLAGS);

  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(UNREPRESENTABLE_MEMBER_MESSAGE);
  }

  if (!memberTypeHasExplicitDeclaration(checker, query)) {
    assertReliableInferredType(typeNode, context);
  }

  const allowsStandardLibraryTypeQuery = declarationsAreStandardLibrary(
    declarationsOf(type.getAliasSymbol() ?? type.getSymbol())
  );

  if (containsTypeQuery(typeNode, context, allowsStandardLibraryTypeQuery, 0)) {
    throw new UnsupportedInspectionError(UNREPRESENTABLE_MEMBER_MESSAGE);
  }

  return typeNode;
};

export const projectMemberTypeQueries = function projectMemberTypeQueries(
  checker: Checker,
  declaration: Declaration,
  projectionContext: DeclarationProjectionContext
): Declaration {
  const visit = (node: Node, depth: number): Node => {
    projectionContext.reserveTraversal(depth);

    return isMemberTypeQuery(checker, node, projectionContext)
      ? resolvedMemberTypeNode(checker, node, projectionContext)
      : visitEachChild(node, (child) => visit(child, depth + 1));
  };

  projectionContext.reserveTraversal(0);

  return visitEachChild(declaration, (child) => visit(child, 1));
};
