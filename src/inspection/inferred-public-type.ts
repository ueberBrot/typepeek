import { Predicate } from "effect";
import {
  isArrowFunction,
  isBlock,
  isClassDeclaration,
  isConditionalExpression,
  isEnumDeclaration,
  isFunctionExpression,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleBlock,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSourceFile,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  SyntaxKind,
} from "tsrs/ast";
import type {
  Declaration,
  Expression,
  Node,
  PropertyDeclaration,
  SignatureDeclaration,
  TypeNode,
  VariableDeclaration,
} from "tsrs/ast";
import {
  NodeBuilderFlags,
  ObjectFlags,
  SignatureKind,
  TypeFlags,
} from "tsrs/sync";
import type {
  Checker,
  Symbol as CompilerSymbol,
  Type,
  TypeReference,
} from "tsrs/sync";

import {
  declarationsOf,
  valueDeclarationOf,
} from "#typepeek/inspection/compiler-session";
import {
  hasModifier,
  unwrapTransparentExpression,
} from "#typepeek/inspection/compiler-syntax";
import { UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPrivateDeclaration } from "#typepeek/inspection/public-declaration-selection";
import { bitwiseAnd } from "#typepeek/integer-bits";

const INFERRED_TYPE_FLAGS = NodeBuilderFlags.NoTruncation;

export interface DeclarationProjectionContext {
  readonly moduleSymbol: CompilerSymbol;
  readonly reserveTraversal: (depth: number) => void;
  readonly reserveTypeTraversal: (depth: number) => void;
  readonly validatedTypes: Set<Type>;
}

const isImplementationLocalDeclaration =
  function isImplementationLocalDeclaration(
    declaration: Declaration,
    reserveTraversal: (depth: number) => void
  ): boolean {
    let depth = 0;

    for (
      let ancestor = declaration.parent;
      ancestor !== undefined;
      ancestor = ancestor.parent
    ) {
      reserveTraversal(depth);
      depth += 1;

      if (isSourceFile(ancestor) || isModuleBlock(ancestor)) {
        return false;
      }

      if (isBlock(ancestor)) {
        return true;
      }
    }

    return false;
  };

const compositeTypeChildren = function compositeTypeChildren(
  type: Type
): readonly Type[] {
  return type.isUnionType() || type.isIntersectionType() ? type.getTypes() : [];
};

const typeParameterTypeChildren = function typeParameterTypeChildren(
  type: Type
): readonly Type[] {
  if (!type.isTypeParameter()) {
    return [];
  }

  const children: Type[] = [];
  const constraint = type.getConstraint();
  const defaultType = type.getDefault();

  if (constraint !== undefined) {
    children.push(constraint);
  }

  if (defaultType !== undefined) {
    children.push(defaultType);
  }

  return children;
};

const isTypeReference = function isTypeReference(
  type: Type
): type is TypeReference {
  return (
    bitwiseAnd(type.flags, TypeFlags.Object) !== 0 &&
    "objectFlags" in type &&
    Predicate.isNumber(type.objectFlags) &&
    bitwiseAnd(type.objectFlags, ObjectFlags.Reference) !== 0
  );
};

const genericTypeChildren = function genericTypeChildren(
  checker: Checker,
  type: Type
): readonly Type[] {
  const children = [
    ...(type.getAliasTypeArguments() ?? []),
    ...typeParameterTypeChildren(type),
  ];

  if (isTypeReference(type)) {
    children.push(...checker.getTypeArguments(type));
  }

  return children;
};

export const isNamedTypeDeclarationSyntax =
  function isNamedTypeDeclarationSyntax(declaration: Declaration): boolean {
    return (
      isClassDeclaration(declaration) ||
      isEnumDeclaration(declaration) ||
      isInterfaceDeclaration(declaration) ||
      isTypeAliasDeclaration(declaration)
    );
  };

const hasNamedTypeSurface = function hasNamedTypeSurface(type: Type): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();

  return declarationsOf(symbol).some(isNamedTypeDeclarationSyntax);
};

const symbolType = function symbolType(
  checker: Checker,
  symbol: CompilerSymbol
): readonly Type[] {
  const declaration = valueDeclarationOf(symbol) ?? declarationsOf(symbol)[0];

  return declaration === undefined
    ? []
    : [checker.getTypeOfSymbolAtLocation(symbol, declaration)];
};

const signatureTypeChildren = function signatureTypeChildren(
  checker: Checker,
  type: Type
): readonly Type[] {
  return [SignatureKind.Call, SignatureKind.Construct].flatMap((kind) =>
    checker.getSignaturesOfType(type, kind).flatMap((signature) => {
      const thisParameter = signature.getThisParameter();

      return [
        checker.getReturnTypeOfSignature(signature),
        ...signature
          .getParameters()
          .flatMap((parameter) => symbolType(checker, parameter)),
        ...(signature.getTypeParameters() ?? []).flatMap(
          typeParameterTypeChildren
        ),
        ...(thisParameter === undefined
          ? []
          : symbolType(checker, thisParameter)),
      ];
    })
  );
};

const propertyTypeChildren = function propertyTypeChildren(
  checker: Checker,
  type: Type
): readonly Type[] {
  return type
    .getProperties()
    .filter(
      (property) =>
        !declarationsOf(property).some((declaration) =>
          isPrivateDeclaration(declaration)
        )
    )
    .flatMap((property) => symbolType(checker, property));
};

const indexTypeChildren = function indexTypeChildren(
  checker: Checker,
  type: Type
): readonly Type[] {
  return checker
    .getIndexInfosOfType(type)
    .flatMap((index) => [index.keyType, index.valueType]);
};

/** Returns only type edges that can contribute to a nameable Public Interface. */
export const inferredPublicTypeChildren = function inferredPublicTypeChildren(
  checker: Checker,
  type: Type
): readonly Type[] {
  const publicChildren = [
    ...compositeTypeChildren(type),
    ...genericTypeChildren(checker, type),
  ];

  return hasNamedTypeSurface(type)
    ? publicChildren
    : [
        ...publicChildren,
        ...signatureTypeChildren(checker, type),
        ...propertyTypeChildren(checker, type),
        ...indexTypeChildren(checker, type),
      ];
};

export const assertNoImplementationLocalType =
  function assertNoImplementationLocalType(
    checker: Checker,
    rootType: Type,
    context: DeclarationProjectionContext
  ): void {
    const pending: {
      readonly depth: number;
      readonly type: Type;
    }[] = [{ depth: 0, type: rootType }];

    const visited = context.validatedTypes;

    for (const { depth, type } of pending) {
      if (visited.has(type)) {
        continue;
      }

      visited.add(type);
      context.reserveTypeTraversal(depth);
      const symbol = type.getAliasSymbol() ?? type.getSymbol();

      if (
        declarationsOf(symbol).some((declaration) =>
          isImplementationLocalDeclaration(
            declaration,
            context.reserveTypeTraversal
          )
        )
      ) {
        throw new UnsupportedInspectionError(
          "An inferred Public Interface references an implementation-local type."
        );
      }

      pending.push(
        ...inferredPublicTypeChildren(checker, type).map((childType) => ({
          depth: depth + 1,
          type: childType,
        }))
      );
    }
  };

const containsDegradedInferredType = function containsDegradedInferredType(
  node: Node,
  reserveTraversal: (depth: number) => void,
  depth: number
): boolean {
  reserveTraversal(depth);

  if (
    node.kind === SyntaxKind.AnyKeyword ||
    node.kind === SyntaxKind.UnknownKeyword ||
    (isTypeLiteralNode(node) && node.members.length === 0)
  ) {
    return true;
  }

  let degraded = false;
  node.forEachChild((child) => {
    degraded ||= containsDegradedInferredType(
      child,
      reserveTraversal,
      depth + 1
    );
  });

  return degraded;
};

export const assertReliableInferredType = function assertReliableInferredType(
  typeNode: TypeNode,
  context: DeclarationProjectionContext
): void {
  if (containsDegradedInferredType(typeNode, context.reserveTraversal, 0)) {
    throw new UnsupportedInspectionError(
      "An inferred Public Interface type cannot be represented statically without standard libraries."
    );
  }
};

export const publicType = function publicType(
  checker: Checker,
  declaration: Declaration,
  explicitType: TypeNode | undefined,
  context: DeclarationProjectionContext
): TypeNode {
  if (explicitType !== undefined) {
    return explicitType;
  }

  const inferredType = checker.getTypeAtLocation(declaration);
  assertNoImplementationLocalType(checker, inferredType, context);

  const typeNode = checker.typeToTypeNode(
    inferredType,
    declaration,
    INFERRED_TYPE_FLAGS
  );

  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(
      "A source-backed declaration type could not be represented statically."
    );
  }

  assertReliableInferredType(typeNode, context);

  return typeNode;
};

export const publicReturnType = function publicReturnType(
  checker: Checker,
  declaration: SignatureDeclaration,
  explicitType: TypeNode | undefined,
  context: DeclarationProjectionContext
): TypeNode {
  if (explicitType !== undefined) {
    return explicitType;
  }

  const signature = checker.getSignatureFromDeclaration(declaration);

  const returnType =
    signature === undefined
      ? undefined
      : checker.getReturnTypeOfSignature(signature);

  if (returnType !== undefined) {
    assertNoImplementationLocalType(checker, returnType, context);
  }

  const typeNode =
    returnType === undefined
      ? undefined
      : checker.typeToTypeNode(returnType, declaration, INFERRED_TYPE_FLAGS);

  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(
      "A source-backed declaration return type could not be represented statically."
    );
  }

  assertReliableInferredType(typeNode, context);

  return typeNode;
};

const containsPublicAsyncValue = function containsPublicAsyncValue(
  expression: Expression
): boolean {
  const value = unwrapTransparentExpression(expression);

  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return hasModifier(value, SyntaxKind.AsyncKeyword);
  }

  if (isConditionalExpression(value)) {
    return (
      containsPublicAsyncValue(value.whenTrue) ||
      containsPublicAsyncValue(value.whenFalse)
    );
  }

  if (!isObjectLiteralExpression(value)) {
    return false;
  }

  return value.properties.some((property) => {
    if (isMethodDeclaration(property)) {
      return hasModifier(property, SyntaxKind.AsyncKeyword);
    }

    return (
      isPropertyAssignment(property) &&
      containsPublicAsyncValue(property.initializer)
    );
  });
};

export const assertRepresentableAsyncInitializer =
  function assertRepresentableAsyncInitializer(
    declaration: VariableDeclaration | PropertyDeclaration
  ): void {
    const { initializer } = declaration;

    if (
      declaration.type === undefined &&
      initializer !== undefined &&
      containsPublicAsyncValue(initializer)
    ) {
      throw new UnsupportedInspectionError(
        "An inferred async Public Interface cannot be represented statically."
      );
    }
  };
