import {
  isAssertionExpression,
  isExportDeclaration,
  isExportSpecifier,
  isImportClause,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isNamedExports,
  isNamedImports,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  SyntaxKind,
} from "tsrs/ast";
import type {
  ClassElement,
  Expression,
  ModifierLike,
  ModifiersBase,
  Node,
} from "tsrs/ast";

/** ModifiersBase is a generated SDK mixin without a corresponding node guard. */
export const modifiersOf = (node: Node): readonly ModifierLike[] | undefined =>
  // SAFETY: the SDK's optional generated ModifiersBase mixin is absent on other node kinds.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SDK node kinds without this optional mixin have no modifiers property.
  (node as Node & Partial<ModifiersBase>).modifiers;

const CLASS_MEMBER_KINDS = new Set<SyntaxKind>([
  SyntaxKind.Constructor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.IndexSignature,
  SyntaxKind.SemicolonClassElement,
  SyntaxKind.ClassStaticBlockDeclaration,
]);

export const isClassMember = (node: Node): node is ClassElement =>
  CLASS_MEMBER_KINDS.has(node.kind);

export const isTypeOnlyAlias = (node: Node): boolean => {
  if (isImportSpecifier(node) || isExportSpecifier(node)) {
    return node.isTypeOnly || isTypeOnlyAlias(node.parent);
  }

  if (isNamedImports(node) || isNamedExports(node)) {
    return isTypeOnlyAlias(node.parent);
  }

  if (isImportClause(node)) {
    return node.phaseModifier === SyntaxKind.TypeKeyword;
  }

  return (
    (isImportEqualsDeclaration(node) || isExportDeclaration(node)) &&
    node.isTypeOnly
  );
};

export const hasModifier = function hasModifier(
  node: Node,
  kind: SyntaxKind
): boolean {
  return (
    modifiersOf(node) !== undefined &&
    (modifiersOf(node) ?? []).some((item) => item.kind === kind)
  );
};

export const unwrapTransparentExpression = function unwrapTransparentExpression(
  expression: Expression
): Expression {
  let value = expression;

  while (
    isParenthesizedExpression(value) ||
    isAssertionExpression(value) ||
    isSatisfiesExpression(value) ||
    isNonNullExpression(value)
  ) {
    value = value.expression;
  }

  return value;
};
