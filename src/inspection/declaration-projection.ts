import { Predicate } from "effect";
import {
  factory,
  isClassDeclaration,
  isConstructorDeclaration,
  isDecorator,
  isEnumDeclaration,
  isEnumMember,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceExport,
  isParameterDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  SyntaxKind,
  TokenFlags,
} from "tsrs/ast";
import type {
  ClassElement,
  Declaration,
  EnumMember,
  Expression,
  FunctionDeclaration,
  MethodDeclaration,
  ModifierLike,
  ModuleBody,
  Node,
  ParameterDeclaration,
  PropertyDeclaration,
  Statement,
  TypeNode,
} from "tsrs/ast";
import type { Checker, Type } from "tsrs/sync";

import { printCompilerNode } from "#typepeek/inspection/compiler-session";
import { modifiersOf, hasModifier } from "#typepeek/inspection/compiler-syntax";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  assertRepresentableAsyncInitializer,
  publicType,
  publicReturnType,
} from "#typepeek/inspection/inferred-public-type";
import type { DeclarationProjectionContext } from "#typepeek/inspection/inferred-public-type";
import {
  collectMemberTypeQueryTypes,
  projectMemberTypeQueries,
} from "#typepeek/inspection/member-type-query-projection";
import {
  isPrivateDeclaration,
  isParameterPropertyModifier,
  publicDeclarations,
  selectPublicClassDeclarations,
} from "#typepeek/inspection/public-declaration-selection";
import type { IdentifiedParameter } from "#typepeek/inspection/public-declaration-selection";

const MAX_INFERRED_TYPE_TRAVERSAL_DEPTH = 64;
const MAX_INFERRED_TYPE_TRAVERSAL_NODES = 4096;

const NAMESPACE_DECLARATION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ClassDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ExportAssignment,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.TypeAliasDeclaration,
]);

export interface DeclarationProjection {
  readonly inferredTypes: readonly Type[];
  readonly syntax: Declaration;
}

const reserveInferredTypeSyntaxTraversal =
  function reserveInferredTypeSyntaxTraversal(
    traversal: {
      nodeCount: number;
    },
    depth: number
  ): void {
    traversal.nodeCount += 1;

    if (
      depth > MAX_INFERRED_TYPE_TRAVERSAL_DEPTH ||
      traversal.nodeCount > MAX_INFERRED_TYPE_TRAVERSAL_NODES
    ) {
      throw new InspectionLimitError(
        "inferred-type-traversal",
        "Inspection exceeded its inferred type traversal limit."
      );
    }
  };

const standaloneProjectionContext = function standaloneProjectionContext(
  checker: Checker,
  declaration: Declaration
): DeclarationProjectionContext {
  const moduleSymbol = checker.getSymbolAtLocation(declaration.getSourceFile());

  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "A public declaration could not be related to its Inspectable Module."
    );
  }

  const traversal = { nodeCount: 0 };
  const typeTraversal = { nodeCount: 0 };

  return {
    moduleSymbol,
    reserveTraversal: (depth) => {
      reserveInferredTypeSyntaxTraversal(traversal, depth);
    },
    reserveTypeTraversal: (depth) => {
      reserveInferredTypeSyntaxTraversal(typeTraversal, depth);
    },
    validatedTypes: new Set(),
  };
};

const collectInferredDeclarationType = function collectInferredDeclarationType(
  checker: Checker,
  declaration: Declaration,
  types: Type[]
): void {
  if (
    (isVariableDeclaration(declaration) ||
      isPropertyDeclaration(declaration) ||
      isParameterDeclaration(declaration)) &&
    declaration.type === undefined
  ) {
    types.push(checker.getTypeAtLocation(declaration));
  }
};

const collectInferredReturnType = function collectInferredReturnType(
  checker: Checker,
  declaration: Declaration,
  types: Type[]
): void {
  if (
    !(
      isFunctionDeclaration(declaration) ||
      isMethodDeclaration(declaration) ||
      isGetAccessorDeclaration(declaration)
    ) ||
    declaration.type !== undefined
  ) {
    return;
  }

  const signature = checker.getSignatureFromDeclaration(declaration);

  if (signature !== undefined) {
    types.push(checker.getReturnTypeOfSignature(signature));
  }
};

const parameterDeclarations = function parameterDeclarations(
  node: Node
): readonly ParameterDeclaration[] {
  if (
    isConstructorDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node)
  ) {
    return node.parameters;
  }

  if (isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)) {
    return node.parameters;
  }

  return [];
};

const inferredPublicClassDeclarations =
  function inferredPublicClassDeclarations(
    checker: Checker,
    declaration: Declaration
  ): readonly Declaration[] {
    if (!isClassDeclaration(declaration)) {
      return [];
    }

    const {
      members: retainedMembers,
      parameterProperties: visibleParameterProperties,
    } = selectPublicClassDeclarations(checker, declaration.members);

    const visibleMembers = retainedMembers.filter(
      (member) => !isPrivateDeclaration(member)
    );

    return [...visibleParameterProperties, ...visibleMembers];
  };

const collectInferredPublicTypes = function collectInferredPublicTypes(
  checker: Checker,
  declaration: Declaration,
  types: Type[]
): void {
  collectInferredDeclarationType(checker, declaration, types);
  collectInferredReturnType(checker, declaration, types);

  for (const parameter of parameterDeclarations(declaration)) {
    collectInferredPublicTypes(checker, parameter, types);
  }

  for (const member of inferredPublicClassDeclarations(checker, declaration)) {
    collectInferredPublicTypes(checker, member, types);
  }
};

const assertRepresentableAsyncDeclaration =
  function assertRepresentableAsyncDeclaration(
    declaration: FunctionDeclaration | MethodDeclaration
  ): void {
    if (
      declaration.type === undefined &&
      !declaration.getSourceFile().isDeclarationFile &&
      hasModifier(declaration, SyntaxKind.AsyncKeyword)
    ) {
      throw new UnsupportedInspectionError(
        "An inferred async Public Interface cannot be represented statically."
      );
    }
  };

const publicModifiers = function publicModifiers(
  modifiers: readonly ModifierLike[] | undefined
): readonly ModifierLike[] | undefined {
  return modifiers?.filter(
    (modifier) =>
      !isDecorator(modifier) && modifier.kind !== SyntaxKind.AsyncKeyword
  );
};

const hasRequiredParameterAfter = function hasRequiredParameterAfter(
  parameter: ParameterDeclaration
): boolean {
  const parameters = parameterDeclarations(parameter.parent);
  const parameterIndex = parameters.indexOf(parameter);

  return parameters
    .slice(parameterIndex + 1)
    .some(
      (candidate) =>
        candidate.questionToken === undefined &&
        candidate.initializer === undefined &&
        candidate.dotDotDotToken === undefined
    );
};

const typeIncludingUndefined = function typeIncludingUndefined(
  type: TypeNode
): TypeNode {
  if (
    isUnionTypeNode(type) &&
    type.types.some((member) => member.kind === SyntaxKind.UndefinedKeyword)
  ) {
    return type;
  }

  return factory.createUnionTypeNode([
    type,
    factory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword),
  ]);
};

const publicParameter = function publicParameter(
  checker: Checker,
  parameter: ParameterDeclaration,
  context: DeclarationProjectionContext
): ParameterDeclaration {
  const type = publicType(checker, parameter, parameter.type, context);
  const hasRequiredFollowingParameter = hasRequiredParameterAfter(parameter);

  return factory.updateParameterDeclaration(
    parameter,
    publicModifiers(parameter.modifiers),
    parameter.dotDotDotToken,
    parameter.name,
    parameter.questionToken ??
      (parameter.initializer === undefined || hasRequiredFollowingParameter
        ? undefined
        : factory.createToken(SyntaxKind.QuestionToken)),
    parameter.initializer !== undefined && hasRequiredFollowingParameter
      ? typeIncludingUndefined(type)
      : type,
    undefined
  );
};

const constantExpression = function constantExpression(
  checker: Checker,
  member: EnumMember
): Expression | undefined {
  const value = checker.getConstantValue(member);

  if (Predicate.isString(value)) {
    return factory.createStringLiteral(value, TokenFlags.None);
  }

  if (!Predicate.isNumber(value) || !Number.isFinite(value)) {
    return undefined;
  }

  return value < 0 || Object.is(value, -0)
    ? factory.createPrefixUnaryExpression(
        SyntaxKind.MinusToken,
        factory.createNumericLiteral(String(Math.abs(value)), TokenFlags.None)
      )
    : factory.createNumericLiteral(String(value), TokenFlags.None);
};

const publicEnumMember = function publicEnumMember(
  checker: Checker,
  member: EnumMember
): EnumMember {
  if (
    member.getSourceFile().isDeclarationFile ||
    member.initializer === undefined
  ) {
    return member;
  }

  return factory.updateEnumMember(
    member,
    member.name,
    constantExpression(checker, member)
  );
};

const publicConstructorParameter = function publicConstructorParameter(
  checker: Checker,
  parameter: ParameterDeclaration,
  context: DeclarationProjectionContext
): ParameterDeclaration {
  const publicParameterDeclaration = publicParameter(
    checker,
    parameter,
    context
  );

  if (!hasModifier(parameter, SyntaxKind.PrivateKeyword)) {
    return publicParameterDeclaration;
  }

  return factory.updateParameterDeclaration(
    publicParameterDeclaration,
    publicParameterDeclaration.modifiers?.filter(
      ({ kind }) => !isParameterPropertyModifier(kind)
    ),
    publicParameterDeclaration.dotDotDotToken,
    publicParameterDeclaration.name,
    publicParameterDeclaration.questionToken,
    publicParameterDeclaration.type,
    undefined
  );
};

const publicClassElement = function publicClassElement(
  checker: Checker,
  member: ClassElement,
  context: DeclarationProjectionContext
): ClassElement {
  if (isConstructorDeclaration(member)) {
    return factory.updateConstructorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.typeParameters,
      hasModifier(member, SyntaxKind.PrivateKeyword)
        ? []
        : member.parameters.map((parameter) =>
            publicConstructorParameter(checker, parameter, context)
          ),
      undefined
    );
  }

  if (isMethodDeclaration(member)) {
    assertRepresentableAsyncDeclaration(member);

    return factory.updateMethodDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.asteriskToken,
      member.name,
      member.postfixToken,
      member.typeParameters,
      member.parameters.map((parameter) =>
        publicParameter(checker, parameter, context)
      ),
      publicReturnType(checker, member, member.type, context),
      undefined
    );
  }

  if (isGetAccessorDeclaration(member)) {
    return factory.updateGetAccessorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.typeParameters,
      member.parameters.map((parameter) =>
        publicParameter(checker, parameter, context)
      ),
      publicReturnType(checker, member, member.type, context),
      undefined
    );
  }

  if (isSetAccessorDeclaration(member)) {
    return factory.updateSetAccessorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.typeParameters,
      member.parameters.map((parameter) =>
        publicParameter(checker, parameter, context)
      ),
      undefined
    );
  }

  if (isPropertyDeclaration(member)) {
    assertRepresentableAsyncInitializer(member);

    return factory.updatePropertyDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.postfixToken,
      publicType(checker, member, member.type, context),
      undefined
    );
  }

  return member;
};

const publicParameterProperty = function publicParameterProperty(
  checker: Checker,
  parameter: IdentifiedParameter,
  context: DeclarationProjectionContext
): PropertyDeclaration {
  const modifiers = publicModifiers(parameter.modifiers)?.filter(
    ({ kind }) => kind !== SyntaxKind.PublicKeyword
  );

  return factory.createPropertyDeclaration(
    modifiers,
    parameter.name,
    parameter.questionToken,
    publicType(checker, parameter, parameter.type, context),
    undefined
  );
};

const publicClassSyntaxElements = function publicClassSyntaxElements(
  checker: Checker,
  members: readonly ClassElement[],
  context: DeclarationProjectionContext
): readonly ClassElement[] {
  const {
    members: retainedMembers,
    parameterProperties: selectedParameterProperties,
  } = selectPublicClassDeclarations(checker, members);

  const parameterProperties = selectedParameterProperties.map((parameter) =>
    publicParameterProperty(checker, parameter, context)
  );

  const projectedMembers = retainedMembers.map((member) =>
    publicClassElement(checker, member, context)
  );

  const constructorIndex = projectedMembers.findIndex(isConstructorDeclaration);

  const propertyIndex = constructorIndex === -1 ? 0 : constructorIndex;

  return [
    ...projectedMembers.slice(0, propertyIndex),
    ...parameterProperties,
    ...projectedMembers.slice(propertyIndex),
  ];
};

const isExportedNamespaceStatement = function isExportedNamespaceStatement(
  statement: Statement
): boolean {
  if (isExportAssignment(statement) || isExportDeclaration(statement)) {
    return true;
  }

  return (
    modifiersOf(statement) !== undefined &&
    (modifiersOf(statement) ?? []).some(
      ({ kind }) => kind === SyntaxKind.ExportKeyword
    )
  );
};

const preserveSyntaxKind = function preserveSyntaxKind<
  ProjectedNode extends Node,
>(original: ProjectedNode, projected: Node): ProjectedNode {
  if (projected.kind !== original.kind) {
    throw new UnsupportedInspectionError(
      "Declaration projection changed the syntax kind."
    );
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: These compiler factory updates preserve syntax kind and names; only implementation bodies, modifiers, and types change.
  return projected as ProjectedNode;
};

const declarationProjection = {
  projectDeclaration(
    checker: Checker,
    declaration: Node,
    context: DeclarationProjectionContext,
    depth: number
  ): Node {
    context.reserveTraversal(depth);

    if (
      isExportAssignment(declaration) &&
      !declaration.getSourceFile().isDeclarationFile
    ) {
      throw new UnsupportedInspectionError(
        "A source-backed default expression cannot be represented without implementation."
      );
    }

    if (isFunctionDeclaration(declaration)) {
      assertRepresentableAsyncDeclaration(declaration);

      return factory.updateFunctionDeclaration(
        declaration,
        publicModifiers(declaration.modifiers),
        declaration.asteriskToken,
        declaration.name,
        declaration.typeParameters,
        declaration.parameters.map((parameter) =>
          publicParameter(checker, parameter, context)
        ),
        publicReturnType(checker, declaration, declaration.type, context),
        undefined
      );
    }

    if (isVariableDeclaration(declaration)) {
      assertRepresentableAsyncInitializer(declaration);

      return factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        publicType(checker, declaration, declaration.type, context),
        undefined
      );
    }

    if (isEnumDeclaration(declaration)) {
      return factory.updateEnumDeclaration(
        declaration,
        publicModifiers(declaration.modifiers),
        declaration.name,
        declaration.members.map((member) => publicEnumMember(checker, member))
      );
    }

    if (isEnumMember(declaration)) {
      return publicEnumMember(checker, declaration);
    }

    if (
      isConstructorDeclaration(declaration) ||
      isMethodDeclaration(declaration) ||
      isPropertyDeclaration(declaration)
    ) {
      return publicClassElement(checker, declaration, context);
    }

    if (
      isGetAccessorDeclaration(declaration) ||
      isSetAccessorDeclaration(declaration)
    ) {
      return publicClassElement(checker, declaration, context);
    }

    if (isClassDeclaration(declaration)) {
      return factory.updateClassDeclaration(
        declaration,
        publicModifiers(declaration.modifiers),
        declaration.name,
        declaration.typeParameters,
        declaration.heritageClauses,
        publicClassSyntaxElements(checker, declaration.members, context)
      );
    }

    if (isModuleDeclaration(declaration)) {
      return factory.updateModuleDeclaration(
        declaration,
        publicModifiers(declaration.modifiers),
        declaration.name,
        declaration.attributes,
        declarationProjection.publicModuleBody(
          checker,
          declaration.body,
          context,
          depth
        )
      );
    }

    return declaration;
  },
  publicDeclaration<ProjectedNode extends Node>(
    checker: Checker,
    declaration: ProjectedNode,
    context: DeclarationProjectionContext,
    depth: number
  ): ProjectedNode {
    return preserveSyntaxKind(
      declaration,
      declarationProjection.projectDeclaration(
        checker,
        declaration,
        context,
        depth
      )
    );
  },
  publicModuleBody(
    checker: Checker,
    body: ModuleBody | undefined,
    context: DeclarationProjectionContext,
    depth: number
  ): ModuleBody | undefined {
    if (body === undefined) {
      return undefined;
    }

    if (isModuleDeclaration(body)) {
      return declarationProjection.publicDeclaration(
        checker,
        body,
        context,
        depth + 1
      );
    }

    if (!isModuleBlock(body)) {
      return body;
    }

    const exportedStatements = body.statements.filter(
      isExportedNamespaceStatement
    );

    const exportedFunctions = exportedStatements.filter(isFunctionDeclaration);

    const publicFunctions = new Set(
      publicDeclarations(checker, exportedFunctions)
    );

    const publicStatements = exportedStatements.filter(
      (statement) =>
        !isFunctionDeclaration(statement) || publicFunctions.has(statement)
    );

    return factory.updateModuleBlock(
      body,
      publicStatements.flatMap((statement) =>
        declarationProjection.publicNamespaceStatement(
          checker,
          statement,
          context,
          depth + 1
        )
      )
    );
  },
  publicNamespaceStatement(
    checker: Checker,
    statement: Statement,
    context: DeclarationProjectionContext,
    depth: number
  ): readonly Statement[] {
    if (isVariableStatement(statement)) {
      return [
        factory.updateVariableStatement(
          statement,
          publicModifiers(statement.modifiers),
          factory.updateVariableDeclarationList(
            statement.declarationList,
            statement.declarationList.declarations.map((declaration) =>
              declarationProjection.publicDeclaration(
                checker,
                declaration,
                context,
                depth + 1
              )
            )
          )
        ),
      ];
    }

    if (NAMESPACE_DECLARATION_KINDS.has(statement.kind)) {
      return [
        declarationProjection.publicDeclaration(
          checker,
          statement,
          context,
          depth
        ),
      ];
    }

    return [];
  },
};

const publicDeclarationSyntaxBeforeMemberTypeQueries =
  function publicDeclarationSyntaxBeforeMemberTypeQueries(
    checker: Checker,
    declaration: Declaration,
    context: DeclarationProjectionContext
  ): Declaration {
    const printableDeclaration =
      isNamespaceExport(declaration) && isExportDeclaration(declaration.parent)
        ? declaration.parent
        : declaration;

    return declarationProjection.publicDeclaration(
      checker,
      printableDeclaration,
      context,
      0
    );
  };

/** Returns checker types synthesized into a source-backed Public Interface. */
const inferredPublicTypes = function inferredPublicTypes(
  checker: Checker,
  declaration: Declaration,
  context: DeclarationProjectionContext
): readonly Type[] {
  const types: Type[] = [];
  collectInferredPublicTypes(checker, declaration, types);
  collectMemberTypeQueryTypes(
    checker,
    publicDeclarationSyntaxBeforeMemberTypeQueries(
      checker,
      declaration,
      context
    ),
    types,
    context,
    0
  );

  return types;
};

const publicDeclarationSyntax = function publicDeclarationSyntax(
  checker: Checker,
  declaration: Declaration,
  context: DeclarationProjectionContext
): Declaration {
  return projectMemberTypeQueries(
    checker,
    publicDeclarationSyntaxBeforeMemberTypeQueries(
      checker,
      declaration,
      context
    ),
    context
  );
};

/** Removes implementation details while preserving the declaration's Public Interface. */
export const projectPublicDeclaration = function projectPublicDeclaration(
  checker: Checker,
  declaration: Declaration,
  context: DeclarationProjectionContext = standaloneProjectionContext(
    checker,
    declaration
  )
): DeclarationProjection {
  return {
    get inferredTypes() {
      return inferredPublicTypes(checker, declaration, context);
    },
    get syntax() {
      return publicDeclarationSyntax(checker, declaration, context);
    },
  };
};

export const renderPublicDeclaration = function renderPublicDeclaration(
  checker: Checker,
  declaration: Declaration,
  context?: DeclarationProjectionContext
): string {
  return printCompilerNode(
    checker,
    projectPublicDeclaration(checker, declaration, context).syntax
  )
    .trim()
    .replace(/^(?:export\s+)?(?:declare\s+)?/u, "");
};
