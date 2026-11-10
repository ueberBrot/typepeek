import {
  isBindingElement,
  isClassLikeDeclaration,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isExportDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isModuleBlock,
  isNumericLiteral,
  isParameterDeclaration,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteralLikeNode,
  isVariableDeclaration,
  SyntaxKind,
} from "tsrs/ast";
import type {
  ClassElement,
  ConstructorDeclaration,
  Declaration,
  Expression,
  FunctionDeclaration,
  Identifier,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  PropertyName,
  SourceFile,
  ModuleBlock,
  Statement,
} from "tsrs/ast";
import { TypeFlags } from "tsrs/sync";
import type { Checker } from "tsrs/sync";

import {
  isClassMember,
  hasModifier,
  unwrapTransparentExpression,
} from "#typepeek/inspection/compiler/compiler-syntax";
import type {
  DeclarationKind,
  DeclarationSpace,
} from "#typepeek/inspection/model/protocol";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

const hasFunctionBody = function hasFunctionBody(
  declaration: Declaration
): declaration is
  | ConstructorDeclaration
  | FunctionDeclaration
  | MethodDeclaration {
  return (
    (isConstructorDeclaration(declaration) ||
      isFunctionDeclaration(declaration) ||
      isMethodDeclaration(declaration)) &&
    declaration.body !== undefined
  );
};

const sameComputedPropertyType = function sameComputedPropertyType(
  checker: Checker,
  left: Expression,
  right: Expression
): boolean {
  const [leftType, rightType] = checker.getTypeAtLocation([left, right]);

  if (leftType === undefined || rightType === undefined) {
    throw new Error("The native compiler returned an incomplete type batch.");
  }

  if (bitwiseAnd(leftType.flags, TypeFlags.UniqueESSymbol) !== 0) {
    return (
      leftType === rightType || leftType.getSymbol() === rightType.getSymbol()
    );
  }

  if (leftType.isStringLiteralType() && rightType.isStringLiteralType()) {
    return leftType.value === rightType.value;
  }

  return leftType.isNumberLiteralType() && rightType.isNumberLiteralType()
    ? leftType.value === rightType.value
    : false;
};

const sameMethodOverloadGroup = function sameMethodOverloadGroup(
  checker: Checker,
  left: Declaration,
  right: Declaration
): boolean | undefined {
  if (!isMethodDeclaration(left) || !isMethodDeclaration(right)) {
    return undefined;
  }

  if (
    hasModifier(left, SyntaxKind.StaticKeyword) !==
    hasModifier(right, SyntaxKind.StaticKeyword)
  ) {
    return false;
  }

  const leftSymbol = checker.getSymbolAtLocation(left.name);
  const rightSymbol = checker.getSymbolAtLocation(right.name);

  if (leftSymbol !== undefined && leftSymbol === rightSymbol) {
    return true;
  }

  return isComputedPropertyName(left.name) && isComputedPropertyName(right.name)
    ? sameComputedPropertyType(
        checker,
        left.name.expression,
        right.name.expression
      ) || undefined
    : undefined;
};

const overloadExpressionName = function overloadExpressionName(
  expression: Expression
): string {
  const value = unwrapTransparentExpression(expression);

  if (isIdentifier(value)) {
    return `identifier:${value.text}`;
  }

  if (isPropertyAccessExpression(value)) {
    return `access:${overloadExpressionName(value.expression)}:${value.name.text}`;
  }

  if (isElementAccessExpression(value)) {
    const argument =
      value.argumentExpression === undefined
        ? undefined
        : unwrapTransparentExpression(value.argumentExpression);

    if (
      argument !== undefined &&
      (isStringLiteralLikeNode(argument) || isNumericLiteral(argument))
    ) {
      return `access:${overloadExpressionName(value.expression)}:${argument.text}`;
    }
  }

  return `syntax:${value.getText()}`;
};

const overloadPropertyName = function overloadPropertyName(
  name: PropertyName
): string {
  if (isPrivateIdentifier(name)) {
    return `private:${name.text}`;
  }

  if (
    isIdentifier(name) ||
    isStringLiteralLikeNode(name) ||
    isNumericLiteral(name)
  ) {
    return `property:${name.text}`;
  }

  if (!isComputedPropertyName(name)) {
    return `syntax:${name.getText()}`;
  }

  const expression = unwrapTransparentExpression(name.expression);

  return isStringLiteralLikeNode(expression) || isNumericLiteral(expression)
    ? `property:${expression.text}`
    : `computed:${overloadExpressionName(expression)}`;
};

const overloadGroup = function overloadGroup(
  declaration: Declaration
): string | undefined {
  if (isConstructorDeclaration(declaration)) {
    return "constructor";
  }

  if (isFunctionDeclaration(declaration)) {
    return `function:${declaration.name?.getText() ?? "default"}`;
  }

  if (isMethodDeclaration(declaration)) {
    const placement = hasModifier(declaration, SyntaxKind.StaticKeyword)
      ? "static"
      : "instance";

    return `method:${placement}:${overloadPropertyName(declaration.name)}`;
  }

  return undefined;
};

const sameOverloadGroup = function sameOverloadGroup(
  checker: Checker,
  left: Declaration,
  right: Declaration
): boolean {
  const sameMethod = sameMethodOverloadGroup(checker, left, right);

  if (sameMethod !== undefined) {
    return sameMethod;
  }

  const leftGroup = overloadGroup(left);

  return leftGroup !== undefined && leftGroup === overloadGroup(right);
};

const isOverloadImplementation = function isOverloadImplementation(
  checker: Checker,
  declaration: Declaration,
  declarations: readonly Declaration[]
): boolean {
  if (!hasFunctionBody(declaration)) {
    return false;
  }

  return declarations.some(
    (candidate) =>
      candidate !== declaration &&
      !hasFunctionBody(candidate) &&
      sameOverloadGroup(checker, declaration, candidate)
  );
};

/** Removes source overload implementations from the declarations visible to callers. */
export const publicDeclarations = function publicDeclarations<
  PublicDeclaration extends Declaration,
>(
  checker: Checker,
  declarations: readonly PublicDeclaration[]
): readonly PublicDeclaration[] {
  return declarations.filter(
    (declaration) =>
      !isOverloadImplementation(checker, declaration, declarations)
  );
};

const hasPrivateIdentifier = function hasPrivateIdentifier(
  node: Node
): boolean {
  if (
    !(
      isPropertyDeclaration(node) ||
      isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)
    )
  ) {
    return false;
  }

  return isPrivateIdentifier(node.name);
};

const isConstructorParameterProperty = function isConstructorParameterProperty(
  node: Node
): node is ParameterDeclaration {
  return isParameterDeclaration(node) && isConstructorDeclaration(node.parent);
};

export const isPrivateDeclaration = function isPrivateDeclaration(
  node: Node
): boolean {
  return (
    hasPrivateIdentifier(node) ||
    (hasModifier(node, SyntaxKind.PrivateKeyword) &&
      !isConstructorParameterProperty(node))
  );
};

const publicClassMembers = function publicClassMembers(
  checker: Checker,
  members: readonly ClassElement[]
): readonly ClassElement[] {
  const membersWithoutImplementations = publicDeclarations(
    checker,
    members.filter(
      (member) =>
        (!isPrivateDeclaration(member) || isConstructorDeclaration(member)) &&
        !isClassStaticBlockDeclaration(member)
    )
  );

  let retainedPrivateConstructor = false;

  return membersWithoutImplementations.filter((member) => {
    if (
      !isConstructorDeclaration(member) ||
      !hasModifier(member, SyntaxKind.PrivateKeyword)
    ) {
      return true;
    }

    if (retainedPrivateConstructor) {
      return false;
    }

    retainedPrivateConstructor = true;

    return true;
  });
};

export const isParameterPropertyModifier = function isParameterPropertyModifier(
  kind: SyntaxKind
): boolean {
  return [
    SyntaxKind.PrivateKeyword,
    SyntaxKind.ProtectedKeyword,
    SyntaxKind.PublicKeyword,
    SyntaxKind.ReadonlyKeyword,
    SyntaxKind.OverrideKeyword,
  ].includes(kind);
};

const isVisibleConstructorParameterProperty =
  function isVisibleConstructorParameterProperty(
    parameter: ParameterDeclaration
  ): parameter is IdentifiedParameter {
    return (
      isIdentifier(parameter.name) &&
      !hasModifier(parameter, SyntaxKind.PrivateKeyword) &&
      (parameter.modifiers ?? []).some(({ kind }) =>
        isParameterPropertyModifier(kind)
      )
    );
  };

const visibleConstructorParameterProperties =
  function visibleConstructorParameterProperties(
    constructorDeclaration: ConstructorDeclaration
  ): readonly IdentifiedParameter[] {
    return constructorDeclaration.parameters.filter(
      isVisibleConstructorParameterProperty
    );
  };

const unrenderedConstructorParameterProperties =
  function unrenderedConstructorParameterProperties(
    members: readonly ClassElement[],
    retainedMembers: ReadonlySet<ClassElement>
  ): readonly IdentifiedParameter[] {
    return members.flatMap((member) =>
      isConstructorDeclaration(member) &&
      (hasModifier(member, SyntaxKind.PrivateKeyword) ||
        !retainedMembers.has(member))
        ? visibleConstructorParameterProperties(member)
        : []
    );
  };

const isDiscardedProjectionSyntax = function isDiscardedProjectionSyntax(
  child: Node
): boolean {
  return (
    isModuleBlock(child) ||
    isClassStaticBlockDeclaration(child) ||
    isDecorator(child)
  );
};

const constructorProjectsOnlyProperties =
  function constructorProjectsOnlyProperties(
    checker: Checker,
    constructorDeclaration: ConstructorDeclaration
  ): boolean {
    if (hasModifier(constructorDeclaration, SyntaxKind.PrivateKeyword)) {
      return true;
    }

    const { parent } = constructorDeclaration;

    return (
      isClassLikeDeclaration(parent) &&
      !publicClassMembers(checker, parent.members).includes(
        constructorDeclaration
      )
    );
  };

const isUnprojectedConstructorChild = function isUnprojectedConstructorChild(
  checker: Checker,
  parent: Node,
  child: Node
): boolean {
  if (
    !isConstructorDeclaration(parent) ||
    !constructorProjectsOnlyProperties(checker, parent)
  ) {
    return false;
  }

  return (
    !isParameterDeclaration(child) ||
    !isVisibleConstructorParameterProperty(child)
  );
};

const isNonPublicClassProjectionChild =
  function isNonPublicClassProjectionChild(
    checker: Checker,
    parent: Node,
    child: Node
  ): boolean {
    if (!isClassLikeDeclaration(parent)) {
      return false;
    }

    if (isConstructorDeclaration(child)) {
      const retained = publicClassMembers(checker, parent.members).includes(
        child
      );

      return retained
        ? hasModifier(child, SyntaxKind.PrivateKeyword) &&
            visibleConstructorParameterProperties(child).length === 0
        : visibleConstructorParameterProperties(child).length === 0;
    }

    if (isClassMember(child)) {
      return !publicClassMembers(checker, parent.members).includes(child);
    }

    return (
      hasPrivateIdentifier(child) ||
      hasModifier(child, SyntaxKind.PrivateKeyword)
    );
  };

const isProjectionFunctionBody = function isProjectionFunctionBody(
  parent: Node,
  child: Node
): boolean {
  return (
    isFunctionLikeDeclaration(parent) &&
    "body" in parent &&
    parent.body === child
  );
};

const isProjectionInitializer = function isProjectionInitializer(
  parent: Node,
  child: Node
): boolean {
  if (
    !(
      isVariableDeclaration(parent) ||
      isPropertyDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent)
    )
  ) {
    return false;
  }

  return parent.initializer === child;
};

/** Selects exactly the source children that can contribute to the projected Public Interface. */
export const isPublicProjectionChild = function isPublicProjectionChild(
  checker: Checker,
  parent: Node,
  child: Node
): boolean {
  if (
    isDiscardedProjectionSyntax(child) ||
    isUnprojectedConstructorChild(checker, parent, child) ||
    isNonPublicClassProjectionChild(checker, parent, child)
  ) {
    return false;
  }

  return (
    !isProjectionFunctionBody(parent, child) &&
    !isProjectionInitializer(parent, child)
  );
};

export type IdentifiedParameter = ParameterDeclaration & {
  readonly name: Identifier;
};

/** Selects the declarations and parameter properties retained by class projection. */
export const selectPublicClassDeclarations =
  function selectPublicClassDeclarations(
    checker: Checker,
    members: readonly ClassElement[]
  ) {
    const retainedMembers = publicClassMembers(checker, members);

    return {
      members: retainedMembers,
      parameterProperties: unrenderedConstructorParameterProperties(
        members,
        new Set(retainedMembers)
      ),
    } as const;
  };

const isExportedStatement = function isExportedStatement(
  statement: Statement
): boolean {
  return (
    isExportDeclaration(statement) ||
    isExportAssignment(statement) ||
    hasModifier(statement, SyntaxKind.ExportKeyword) ||
    hasModifier(statement, SyntaxKind.DefaultKeyword)
  );
};

export const selectPublicStatements = function selectPublicStatements(
  checker: Checker,
  container: SourceFile | ModuleBlock
): readonly Statement[] {
  const exported = container.statements.filter(isExportedStatement);

  const publicFunctions = new Set(
    publicDeclarations(checker, exported.filter(isFunctionDeclaration))
  );

  return exported.filter(
    (statement) =>
      !isFunctionDeclaration(statement) || publicFunctions.has(statement)
  );
};

const DECLARATION_KIND_BY_SYNTAX_KIND = new Map<SyntaxKind, DeclarationKind>([
  [SyntaxKind.ClassDeclaration, "class"],
  [SyntaxKind.EnumDeclaration, "enum"],
  [SyntaxKind.FunctionDeclaration, "function"],
  [SyntaxKind.InterfaceDeclaration, "interface"],
  [SyntaxKind.ModuleDeclaration, "namespace"],
  [SyntaxKind.TypeAliasDeclaration, "type-alias"],
  [SyntaxKind.VariableDeclaration, "variable"],
  [SyntaxKind.ExportAssignment, "alias"],
  [SyntaxKind.ExportSpecifier, "alias"],
  [SyntaxKind.ImportEqualsDeclaration, "alias"],
  [SyntaxKind.NamespaceExport, "alias"],
  [SyntaxKind.PropertyDeclaration, "property"],
  [SyntaxKind.PropertySignature, "property"],
  [SyntaxKind.MethodDeclaration, "method"],
  [SyntaxKind.MethodSignature, "method"],
  [SyntaxKind.Constructor, "constructor"],
  [SyntaxKind.ConstructSignature, "constructor"],
  [SyntaxKind.GetAccessor, "accessor"],
  [SyntaxKind.SetAccessor, "accessor"],
  [SyntaxKind.EnumMember, "enum-member"],
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

export const declarationKind = function declarationKind(
  declaration: Declaration
): DeclarationKind | undefined {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind);
};

export const declarationSpaces = function declarationSpaces(
  declaration: Declaration
): readonly DeclarationSpace[] {
  const kind = declarationKind(declaration);

  return kind === undefined ? [] : DECLARATION_POLICY_BY_KIND[kind].spaces;
};

export const declarationSupportsTypeQuery =
  function declarationSupportsTypeQuery(declaration: Declaration): boolean {
    const kind = declarationKind(declaration);

    return (
      kind !== undefined && DECLARATION_POLICY_BY_KIND[kind].supportsTypeQuery
    );
  };
