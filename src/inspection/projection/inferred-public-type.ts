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
} from "tsrs/async";
import type {
  Checker,
  Symbol as CompilerSymbol,
  Type,
  TypeReference,
} from "tsrs/async";

import {
  declarationsOf,
  valueDeclarationOf,
} from "#typepeek/inspection/compiler/compiler-session";
import {
  hasModifier,
  unwrapTransparentExpression,
} from "#typepeek/inspection/compiler/compiler-syntax";
import { UnsupportedInspectionError } from "#typepeek/inspection/model/errors";
import { isPrivateDeclaration } from "#typepeek/inspection/projection/public-declaration-selection";
import { mapAsync, filterAsync } from "#typepeek/shared/async-collection";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

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

const compositeTypeChildren = async function compositeTypeChildren(
  type: Type
): Promise<readonly Type[]> {
  return type.isUnionType() || type.isIntersectionType()
    ? await type.getTypes()
    : [];
};

const typeParameterTypeChildren = async function typeParameterTypeChildren(
  type: Type
): Promise<readonly Type[]> {
  if (!type.isTypeParameter()) {
    return [];
  }

  const children: Type[] = [];
  const constraint = await type.getConstraint();
  const defaultType = await type.getDefault();

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

const genericTypeChildren = async function genericTypeChildren(
  checker: Checker,
  type: Type
): Promise<readonly Type[]> {
  const children = [
    ...((await type.getAliasTypeArguments()) ?? []),
    ...(await typeParameterTypeChildren(type)),
  ];

  if (isTypeReference(type)) {
    children.push(...(await checker.getTypeArguments(type)));
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

const hasNamedTypeSurface = async function hasNamedTypeSurface(
  type: Type
): Promise<boolean> {
  const symbol = (await type.getAliasSymbol()) ?? (await type.getSymbol());

  const declarations = await declarationsOf(symbol);

  return declarations.some(isNamedTypeDeclarationSyntax);
};

const symbolType = async function symbolType(
  checker: Checker,
  symbol: CompilerSymbol
): Promise<readonly Type[]> {
  let declaration = await valueDeclarationOf(symbol);

  if (declaration === undefined) {
    const declarations = await declarationsOf(symbol);
    [declaration] = declarations;
  }

  return declaration === undefined
    ? []
    : [await checker.getTypeOfSymbolAtLocation(symbol, declaration)];
};

const signatureTypeChildren = async function signatureTypeChildren(
  checker: Checker,
  type: Type
): Promise<readonly Type[]> {
  const groups = await mapAsync(
    [SignatureKind.Call, SignatureKind.Construct],
    async (kind) => {
      const signatures = await checker.getSignaturesOfType(type, kind);

      const signatureTypes = await mapAsync(signatures, async (signature) => {
        const thisParameter = await signature.getThisParameter();
        const parameters = await signature.getParameters();

        const parameterTypes = await mapAsync(
          parameters,
          async (parameter) => await symbolType(checker, parameter)
        );

        const typeParameters = (await signature.getTypeParameters()) ?? [];

        const typeParameterTypes = await mapAsync(
          typeParameters,
          async (parameter) => await typeParameterTypeChildren(parameter)
        );

        return [
          await checker.getReturnTypeOfSignature(signature),
          ...parameterTypes.flat(),
          ...typeParameterTypes.flat(),
          ...(thisParameter === undefined
            ? []
            : await symbolType(checker, thisParameter)),
        ];
      });

      return signatureTypes.flat();
    }
  );

  return groups.flat();
};

const propertyTypeChildren = async function propertyTypeChildren(
  checker: Checker,
  type: Type
): Promise<readonly Type[]> {
  const properties = await type.getProperties();

  const visible = await filterAsync(properties, async (property) => {
    const declarations = await declarationsOf(property);

    return !declarations.some((declaration) =>
      isPrivateDeclaration(declaration)
    );
  });

  const types = await mapAsync(
    visible,
    async (property) => await symbolType(checker, property)
  );

  return types.flat();
};

const indexTypeChildren = async function indexTypeChildren(
  checker: Checker,
  type: Type
): Promise<readonly Type[]> {
  const indexInfosOfType = await checker.getIndexInfosOfType(type);

  return indexInfosOfType.flatMap((index) => [index.keyType, index.valueType]);
};

/** Returns only type edges that can contribute to a nameable Public Interface. */
export const inferredPublicTypeChildren =
  async function inferredPublicTypeChildren(
    checker: Checker,
    type: Type
  ): Promise<readonly Type[]> {
    const publicChildren = [
      ...(await compositeTypeChildren(type)),
      ...(await genericTypeChildren(checker, type)),
    ];

    return (await hasNamedTypeSurface(type))
      ? publicChildren
      : [
          ...publicChildren,
          ...(await signatureTypeChildren(checker, type)),
          ...(await propertyTypeChildren(checker, type)),
          ...(await indexTypeChildren(checker, type)),
        ];
  };

export const assertNoImplementationLocalType =
  async function assertNoImplementationLocalType(
    checker: Checker,
    rootType: Type,
    context: DeclarationProjectionContext
  ): Promise<void> {
    const pending: {
      readonly depth: number;
      readonly type: Type;
    }[] = [{ depth: 0, type: rootType }];

    const visited = context.validatedTypes;

    /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
    for (const { depth, type } of pending) {
      if (visited.has(type)) {
        continue;
      }

      visited.add(type);
      context.reserveTypeTraversal(depth);
      const symbol = (await type.getAliasSymbol()) ?? (await type.getSymbol());

      const declarations = await declarationsOf(symbol);

      if (
        declarations.some((declaration) =>
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

      const inferredPublicTypeChildrenResult = await inferredPublicTypeChildren(
        checker,
        type
      );

      pending.push(
        ...inferredPublicTypeChildrenResult.map((childType) => ({
          depth: depth + 1,
          type: childType,
        }))
      );
    }
    /* oxlint-enable eslint/no-await-in-loop */
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

export const publicType = async function publicType(
  checker: Checker,
  declaration: Declaration,
  explicitType: TypeNode | undefined,
  context: DeclarationProjectionContext
): Promise<TypeNode> {
  if (explicitType !== undefined) {
    return explicitType;
  }

  const inferredType = await checker.getTypeAtLocation(declaration);
  await assertNoImplementationLocalType(checker, inferredType, context);

  const typeNode = await checker.typeToTypeNode(
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

export const publicReturnType = async function publicReturnType(
  checker: Checker,
  declaration: SignatureDeclaration,
  explicitType: TypeNode | undefined,
  context: DeclarationProjectionContext
): Promise<TypeNode> {
  if (explicitType !== undefined) {
    return explicitType;
  }

  const signature = await checker.getSignatureFromDeclaration(declaration);

  const returnType =
    signature === undefined
      ? undefined
      : await checker.getReturnTypeOfSignature(signature);

  if (returnType !== undefined) {
    await assertNoImplementationLocalType(checker, returnType, context);
  }

  const typeNode =
    returnType === undefined
      ? undefined
      : await checker.typeToTypeNode(
          returnType,
          declaration,
          INFERRED_TYPE_FLAGS
        );

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
