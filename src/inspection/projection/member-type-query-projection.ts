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
} from "tsrs/ast";
import type { Declaration, Node, TypeNode, TypeQueryNode } from "tsrs/ast";
import { NodeBuilderFlags, SymbolFlags } from "tsrs/async";
import type { Checker, Symbol as CompilerSymbol, Type } from "tsrs/async";

import { aliasedSymbol } from "#typepeek/inspection/compiler/compiler-queries";
import {
  declarationsOf,
  isSourceBackedNode,
} from "#typepeek/inspection/compiler/compiler-session";
import {
  visitEachChildAsync,
  forEachChildAsync,
} from "#typepeek/inspection/compiler/compiler-traversal";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/compiler/typescript-standard-library";
import { UnsupportedInspectionError } from "#typepeek/inspection/model/errors";
import {
  assertNoImplementationLocalType,
  assertReliableInferredType,
  isNamedTypeDeclarationSyntax,
} from "#typepeek/inspection/projection/inferred-public-type";
import type { DeclarationProjectionContext } from "#typepeek/inspection/projection/inferred-public-type";
import { isWellKnownSymbolMemberName } from "#typepeek/inspection/projection/well-known-symbol";
import { findAsync, someAsync } from "#typepeek/shared/async-collection";
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

const resolvedSymbolAtLocation = async function resolvedSymbolAtLocation(
  checker: Checker,
  node: Node
): Promise<CompilerSymbol | undefined> {
  if (!isSourceBackedNode(node)) {
    return undefined;
  }

  const symbol = await checker.getSymbolAtLocation(node);

  return symbol !== undefined &&
    bitwiseAnd(symbol.flags, SymbolFlags.Alias) !== 0
    ? await aliasedSymbol(checker, symbol)
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

const isWellKnownSymbolTypeQuery = async function isWellKnownSymbolTypeQuery(
  checker: Checker,
  node: TypeQueryNode
): Promise<boolean> {
  if (
    !isQualifiedName(node.exprName) ||
    !isIdentifier(node.exprName.left) ||
    node.exprName.left.text !== "Symbol" ||
    !isWellKnownSymbolMemberName(node.exprName.right.text)
  ) {
    return false;
  }

  const rootSymbol = await resolvedSymbolAtLocation(
    checker,
    node.exprName.left
  );

  return (
    rootSymbol === undefined ||
    declarationsAreStandardLibrary((await declarationsOf(rootSymbol)) ?? [])
  );
};

/** Identifies declarations owned by a Member rather than the selected Inspectable Module. */
export const declarationOwnerIsMember = async function declarationOwnerIsMember(
  checker: Checker,
  moduleSymbol: CompilerSymbol,
  declaration: Declaration,
  reserveTraversal: (depth: number) => void
): Promise<boolean> {
  let ancestor = declaration.parent;

  /* oxlint-disable eslint/no-await-in-loop -- Each ancestor determines the next owner and consumes traversal depth. */
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
        (await checker.getSymbolAtLocation(
          isModuleDeclaration(ancestor.parent)
            ? ancestor.parent.name
            : ancestor.parent
        )) !== moduleSymbol
      );
    }

    if (MEMBER_CONTAINER_KINDS.has(ancestor.kind)) {
      return true;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return false;
};

const isMemberTypeQuery = async function isMemberTypeQuery(
  checker: Checker,
  node: Node,
  context: DeclarationProjectionContext
): Promise<boolean> {
  if (!isTypeQueryNode(node)) {
    return false;
  }

  if (await isWellKnownSymbolTypeQuery(checker, node)) {
    return false;
  }

  const symbol = await resolvedSymbolAtLocation(checker, node.exprName);
  const declarations = (await declarationsOf(symbol)) ?? [];

  if (
    await someAsync(
      declarations,
      async (declaration) =>
        !isTypeScriptStandardLibraryDeclaration(
          declaration.getSourceFile().fileName
        ) &&
        (await declarationOwnerIsMember(
          checker,
          context.moduleSymbol,
          declaration,
          context.reserveTraversal
        ))
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
  async function standardLibraryTypeQueryIsAuthoritative(
    checker: Checker,
    typeQuery: TypeQueryNode
  ): Promise<boolean> {
    const typeSymbol = await resolvedSymbolAtLocation(
      checker,
      typeQuery.exprName
    );

    return (
      declarationsAreStandardLibrary(
        (await declarationsOf(typeSymbol)) ?? []
      ) || (await isWellKnownSymbolTypeQuery(checker, typeQuery))
    );
  };

const exactStandardLibraryMemberTypeQuery =
  async function exactStandardLibraryMemberTypeQuery(
    checker: Checker,
    query: TypeQueryNode
  ): Promise<TypeQueryNode | undefined> {
    const symbol = await resolvedSymbolAtLocation(checker, query.exprName);

    const declarationsResult = await declarationsOf(symbol);

    const found = await findAsync(
      declarationsResult.map(explicitDeclarationType),
      async (typeNode) =>
        typeNode !== undefined &&
        isTypeQueryNode(typeNode) &&
        (await standardLibraryTypeQueryIsAuthoritative(checker, typeNode))
    );

    return found !== undefined && isTypeQueryNode(found) ? found : undefined;
  };

export const collectMemberTypeQueryTypes =
  async function collectMemberTypeQueryTypes(
    checker: Checker,
    node: Node,
    types: Type[],
    context: DeclarationProjectionContext,
    depth: number
  ): Promise<void> {
    context.reserveTraversal(depth);

    if (
      isTypeQueryNode(node) &&
      (await isMemberTypeQuery(checker, node, context))
    ) {
      if (
        (await exactStandardLibraryMemberTypeQuery(checker, node)) === undefined
      ) {
        types.push(await checker.getTypeAtLocation(node.exprName));
      }

      return;
    }

    await forEachChildAsync(node, async (child) => {
      await collectMemberTypeQueryTypes(
        checker,
        child,
        types,
        context,
        depth + 1
      );
    });
  };

const assertMemberTypeSymbolIsRepresentable =
  async function assertMemberTypeSymbolIsRepresentable(
    checker: Checker,
    type: Type,
    context: DeclarationProjectionContext
  ): Promise<void> {
    const symbol = (await type.getAliasSymbol()) ?? (await type.getSymbol());

    if (
      symbol !== undefined &&
      (await someAsync(
        await declarationsOf(symbol),
        async (declaration) =>
          (isNamedTypeDeclarationSyntax(declaration) ||
            isEnumMember(declaration)) &&
          (await declarationOwnerIsMember(
            checker,
            context.moduleSymbol,
            declaration,
            context.reserveTraversal
          ))
      ))
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
  async function memberTypeHasExplicitDeclaration(
    checker: Checker,
    query: TypeQueryNode
  ): Promise<boolean> {
    const symbol = await resolvedSymbolAtLocation(checker, query.exprName);

    const declarationsResult = await declarationsOf(symbol);

    return declarationsResult.some(declarationHasExplicitType);
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

const resolvedMemberTypeNode = async function resolvedMemberTypeNode(
  checker: Checker,
  query: TypeQueryNode,
  context: DeclarationProjectionContext
): Promise<TypeNode> {
  const exactStandardLibraryQuery = await exactStandardLibraryMemberTypeQuery(
    checker,
    query
  );

  if (exactStandardLibraryQuery !== undefined) {
    return exactStandardLibraryQuery;
  }

  const type = await checker.getTypeAtLocation(query.exprName);
  await assertNoImplementationLocalType(checker, type, context);
  await assertMemberTypeSymbolIsRepresentable(checker, type, context);

  const typeNode = await checker.typeToTypeNode(
    type,
    query,
    MEMBER_TYPE_QUERY_FLAGS
  );

  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(UNREPRESENTABLE_MEMBER_MESSAGE);
  }

  if (!(await memberTypeHasExplicitDeclaration(checker, query))) {
    assertReliableInferredType(typeNode, context);
  }

  const allowsStandardLibraryTypeQuery = declarationsAreStandardLibrary(
    await declarationsOf(
      (await type.getAliasSymbol()) ?? (await type.getSymbol())
    )
  );

  if (containsTypeQuery(typeNode, context, allowsStandardLibraryTypeQuery, 0)) {
    throw new UnsupportedInspectionError(UNREPRESENTABLE_MEMBER_MESSAGE);
  }

  return typeNode;
};

export const projectMemberTypeQueries = async function projectMemberTypeQueries(
  checker: Checker,
  declaration: Declaration,
  projectionContext: DeclarationProjectionContext
): Promise<Declaration> {
  const visit = async (node: Node, depth: number): Promise<Node> => {
    projectionContext.reserveTraversal(depth);

    return isTypeQueryNode(node) &&
      (await isMemberTypeQuery(checker, node, projectionContext))
      ? await resolvedMemberTypeNode(checker, node, projectionContext)
      : await visitEachChildAsync(
          node,
          async (child) => await visit(child, depth + 1)
        );
  };

  projectionContext.reserveTraversal(0);

  return await visitEachChildAsync(
    declaration,
    async (child) => await visit(child, 1)
  );
};
