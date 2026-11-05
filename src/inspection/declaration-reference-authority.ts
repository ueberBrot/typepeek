import { builtinModules } from "node:module";

import { Predicate } from "effect";
import {
  isAsExpression,
  isExportDeclaration,
  isExpressionWithTypeArguments,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isMethodDeclaration,
  isModuleDeclaration,
  isNumericLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isQualifiedName,
  isSourceFile,
  isStringLiteralLikeNode,
  isTypeAssertion,
  isTypeQueryNode,
  isTypeReferenceNode,
} from "tsrs/ast";
import type {
  Declaration,
  EntityName,
  Expression,
  Identifier,
  Node,
  TypeReferenceNode,
} from "tsrs/ast";
import { SymbolFlags, TypeFlags } from "tsrs/sync";
import type { Checker, Program, Symbol as CompilerSymbol } from "tsrs/sync";

import { COMPILER_VERSION } from "#typepeek/inspection/compiler-distribution";
import {
  symbolAtLocation,
  symbolsAtLocations,
} from "#typepeek/inspection/compiler-queries";
import { declarationsOf } from "#typepeek/inspection/compiler-session";
import { UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin } from "#typepeek/inspection/evidence-boundary";
import { publicDeclarations } from "#typepeek/inspection/public-declaration-selection";
import { readStandardGlobalCatalog } from "#typepeek/inspection/standard-global-catalog";
import { isWellKnownSymbolMemberName } from "#typepeek/inspection/well-known-symbol";
import { bitwiseAnd } from "#typepeek/integer-bits";

const NODE_PLATFORM_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`
  ),
]);

interface StandardGlobalSpaces {
  type: boolean;
  value: boolean;
}

let standardGlobalNames: ReadonlyMap<string, StandardGlobalSpaces> | undefined;

export interface NodeProviderProgram {
  readonly program: Program;
  readonly providerRoot: string;
}

interface GlobalCandidate {
  readonly target: Node;
}

export const isNodePlatformSpecifier = function isNodePlatformSpecifier(
  specifier: string
): boolean {
  return specifier.startsWith("node:") && specifier.length > "node:".length;
};

export const isKnownNodePlatformSpecifier =
  function isKnownNodePlatformSpecifier(specifier: string): boolean {
    return NODE_PLATFORM_SPECIFIERS.has(specifier);
  };

const importOrExportSpecifier = function importOrExportSpecifier(
  node: Node
): string | undefined {
  if (!isImportDeclaration(node) && !isExportDeclaration(node)) {
    return undefined;
  }

  return node.moduleSpecifier !== undefined &&
    isStringLiteralLikeNode(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
};

const importEqualsSpecifier = function importEqualsSpecifier(
  node: Node
): string | undefined {
  if (
    !isImportEqualsDeclaration(node) ||
    !isExternalModuleReference(node.moduleReference)
  ) {
    return undefined;
  }

  const { expression } = node.moduleReference;

  return expression !== undefined && isStringLiteralLikeNode(expression)
    ? expression.text
    : undefined;
};

const importTypeSpecifier = function importTypeSpecifier(
  node: Node
): string | undefined {
  if (!isImportTypeNode(node) || !isLiteralTypeNode(node.argument)) {
    return undefined;
  }

  return isStringLiteralLikeNode(node.argument.literal)
    ? node.argument.literal.text
    : undefined;
};

const ambientModuleSpecifier = function ambientModuleSpecifier(
  node: Node
): string | undefined {
  return isModuleDeclaration(node) && isStringLiteralLikeNode(node.name)
    ? node.name.text
    : undefined;
};

const referencedModuleSpecifier = function referencedModuleSpecifier(
  node: Node
): string | undefined {
  return (
    importOrExportSpecifier(node) ??
    importEqualsSpecifier(node) ??
    importTypeSpecifier(node) ??
    ambientModuleSpecifier(node)
  );
};

const directNodeReference = function directNodeReference(node: Node): boolean {
  if (
    isSourceFile(node) &&
    node.typeReferenceDirectives.some(({ fileName }) => fileName === "node")
  ) {
    return true;
  }

  const specifier = referencedModuleSpecifier(node);

  return specifier !== undefined && isKnownNodePlatformSpecifier(specifier);
};

const directNodeReferenceCandidate = function directNodeReferenceCandidate(
  node: Node
): Node | undefined {
  if (!isImportTypeNode(node)) {
    return undefined;
  }

  if (node.qualifier !== undefined) {
    return node.qualifier;
  }

  return isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
};

const isConstAssertionType = function isConstAssertionType(
  node: TypeReferenceNode
): boolean {
  if (!isIdentifier(node.typeName) || node.typeName.text !== "const") {
    return false;
  }

  const { parent } = node;

  return (
    (isAsExpression(parent) || isTypeAssertion(parent)) && parent.type === node
  );
};

const entityNameRoot = function entityNameRoot(name: EntityName): Identifier {
  let current = name;

  while (isQualifiedName(current)) {
    current = current.left;
  }

  return current;
};

const expressionRoot = function expressionRoot(
  expression: Expression
): Identifier | undefined {
  let current = expression;

  while (isPropertyAccessExpression(current)) {
    current = current.expression;
  }

  return isIdentifier(current) ? current : undefined;
};

const possibleGlobalReference = function possibleGlobalReference(node: Node):
  | {
      readonly root: Identifier;
      readonly space: "type" | "value";
      readonly target: Node;
    }
  | undefined {
  if (isTypeReferenceNode(node)) {
    if (isConstAssertionType(node)) {
      return undefined;
    }

    const root = entityNameRoot(node.typeName);

    return { root, space: "type", target: node.typeName };
  }

  if (isTypeQueryNode(node)) {
    const root = entityNameRoot(node.exprName);

    return { root, space: "value", target: node.exprName };
  }

  if (isExpressionWithTypeArguments(node)) {
    const root = expressionRoot(node.expression);

    return root === undefined
      ? undefined
      : { root, space: "type", target: node.expression };
  }

  return undefined;
};

const resolvedSymbolDeclarations = function resolvedSymbolDeclarations(
  checker: Checker,
  symbol: CompilerSymbol | undefined
): readonly Declaration[] {
  if (symbol === undefined) {
    return [];
  }

  const resolved = bitwiseAnd(symbol.flags, SymbolFlags.Alias)
    ? checker.getAliasedSymbol(symbol)
    : symbol;

  return publicDeclarations(checker, declarationsOf(resolved) ?? []);
};

const resolvedReferenceSymbol = function resolvedReferenceSymbol(
  checker: Checker,
  reference: NonNullable<ReturnType<typeof possibleGlobalReference>>
): CompilerSymbol | undefined {
  const targetSymbol = symbolAtLocation(checker, reference.target);

  if (resolvedSymbolDeclarations(checker, targetSymbol).length > 0) {
    return targetSymbol;
  }

  const rootSymbol = symbolAtLocation(checker, reference.root);

  return resolvedSymbolDeclarations(checker, rootSymbol).length > 0
    ? rootSymbol
    : targetSymbol;
};

const referencePath = function referencePath(node: Node): string[] | undefined {
  if (isIdentifier(node)) {
    return [node.text];
  }

  if (isQualifiedName(node)) {
    const left = referencePath(node.left);

    return left === undefined ? undefined : [...left, node.right.text];
  }

  if (isPropertyAccessExpression(node)) {
    const expression = referencePath(node.expression);

    return expression === undefined
      ? undefined
      : [...expression, node.name.text];
  }

  return undefined;
};

const standardReferencePath = function standardReferencePath(
  target: Node
): readonly string[] | undefined {
  const path = referencePath(target);

  return path?.[0] === "globalThis" && path.length > 1 ? path.slice(1) : path;
};

const isWellKnownSymbolReference = function isWellKnownSymbolReference(
  path: readonly string[],
  space: "type" | "value"
): boolean {
  if (space !== "value") {
    return false;
  }

  if (path.length !== 2) {
    return false;
  }

  if (path[0] !== "Symbol") {
    return false;
  }

  return isWellKnownSymbolMemberName(path[1] ?? "");
};

const embeddedStandardGlobals = globalThis.__TYPEPEEK_STANDARD_GLOBALS__;

const standardGlobals = function standardGlobals(
  reserveTraversalNode: () => void
): ReadonlyMap<string, StandardGlobalSpaces> {
  if (standardGlobalNames !== undefined) {
    return standardGlobalNames;
  }

  const catalog =
    embeddedStandardGlobals?.compilerVersion === COMPILER_VERSION
      ? embeddedStandardGlobals
      : readStandardGlobalCatalog();

  for (let index = 0; index < catalog.traversalNodes; index += 1) {
    reserveTraversalNode();
  }

  standardGlobalNames = new Map(
    catalog.entries.map(([name, spaces]) => [
      name,
      { type: bitwiseAnd(spaces, 1) !== 0, value: bitwiseAnd(spaces, 2) !== 0 },
    ])
  );

  return standardGlobalNames;
};

const isStandardReference = function isStandardReference(
  reference: NonNullable<ReturnType<typeof possibleGlobalReference>>,
  reserveTraversalNode: () => void
): boolean {
  const path = standardReferencePath(reference.target);

  if (path === undefined || path.length === 0) {
    return false;
  }

  if (isWellKnownSymbolReference(path, reference.space)) {
    return true;
  }

  return (
    standardGlobals(reserveTraversalNode).get(path.join("."))?.[
      reference.space
    ] === true
  );
};

const isValueReferenceIdentifier = function isValueReferenceIdentifier(
  identifier: Identifier
): boolean {
  const { parent } = identifier;

  if (isPropertyAccessExpression(parent)) {
    return parent.name !== identifier;
  }

  if (
    isPropertyAssignment(parent) ||
    isMethodDeclaration(parent) ||
    isPropertyDeclaration(parent)
  ) {
    return parent.name !== identifier;
  }

  return true;
};

const valueReferenceTarget = function valueReferenceTarget(
  identifier: Identifier
): Expression {
  let current: Expression = identifier;

  while (
    isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }

  return current;
};

const isStandardGlobal = function isStandardGlobal(
  name: string,
  space: "type" | "value",
  reserveTraversalNode: () => void
): boolean {
  return standardGlobals(reserveTraversalNode).get(name)?.[space] === true;
};

const isTrustedStandardValueMember = function isTrustedStandardValueMember(
  target: Expression,
  root: Identifier
): boolean {
  if (!isPropertyAccessExpression(target) || target.expression !== root) {
    return false;
  }

  const globalValue: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    root.text
  )?.value;

  return (
    (Predicate.isFunction(globalValue) ||
      Predicate.isObjectOrArray(globalValue)) &&
    Object.getOwnPropertyDescriptor(globalValue, target.name.text) !== undefined
  );
};

const isStandardValueReference = function isStandardValueReference(
  target: Expression,
  root: Identifier,
  reserveTraversalNode: () => void
): boolean {
  if (!isStandardGlobal(root.text, "value", reserveTraversalNode)) {
    return false;
  }

  if (target === root) {
    return true;
  }

  return isTrustedStandardValueMember(target, root);
};

const isStandardSymbolMember = function isStandardSymbolMember(
  expression: Expression
): boolean {
  return (
    isPropertyAccessExpression(expression) &&
    isIdentifier(expression.expression) &&
    expression.expression.text === "Symbol" &&
    isWellKnownSymbolMemberName(expression.name.text)
  );
};

const isRepresentableComputedName = function isRepresentableComputedName(
  checker: Checker,
  expression: Expression
): boolean {
  if (
    isStringLiteralLikeNode(expression) ||
    isNumericLiteral(expression) ||
    isStandardSymbolMember(expression)
  ) {
    return true;
  }

  const { flags } = checker.getTypeAtLocation(expression);

  if (
    bitwiseAnd(flags, TypeFlags.UniqueESSymbol) ||
    bitwiseAnd(flags, TypeFlags.StringLiteral) ||
    bitwiseAnd(flags, TypeFlags.NumberLiteral)
  ) {
    return true;
  }

  return false;
};

const unrepresentableComputedName =
  function unrepresentableComputedName(): UnsupportedInspectionError {
    return new UnsupportedInspectionError(
      "A computed Public Interface name cannot be represented statically."
    );
  };

const unresolvedGlobalReference =
  function unresolvedGlobalReference(): UnsupportedInspectionError {
    return new UnsupportedInspectionError(
      "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider."
    );
  };

const providerDefinesCandidates = function providerDefinesCandidates(
  provider: NodeProviderProgram,
  candidates: readonly GlobalCandidate[]
): boolean {
  const { checker } = provider.program.getProject();

  return symbolsAtLocations(
    checker,
    candidates.map(({ target }) => target)
  ).every((symbol) =>
    resolvedSymbolDeclarations(checker, symbol).some((declaration) =>
      isPathWithin(provider.providerRoot, declaration.getSourceFile().fileName)
    )
  );
};

/** Owns the unresolved references and computed names collected by one Public Interface scan. */
export class DeclarationReferenceAuthority {
  private readonly checker: Checker;
  private readonly reserveTraversalNode: () => void;
  private readonly candidates: GlobalCandidate[] = [];
  private readonly computedNames: Expression[] = [];
  private directReference = false;

  constructor(checker: Checker, reserveTraversalNode: () => void) {
    this.checker = checker;
    this.reserveTraversalNode = reserveTraversalNode;
  }

  prefetch(nodes: readonly Node[]): void {
    symbolsAtLocations(
      this.checker,
      nodes.flatMap((node) => {
        const reference = possibleGlobalReference(node);

        return reference === undefined ? [] : [reference.target];
      })
    );
  }

  private inspectReference(node: Node):
    | {
        readonly symbol: CompilerSymbol;
        readonly declarations: readonly Declaration[];
      }
    | undefined {
    const reference = possibleGlobalReference(node);

    if (reference === undefined) {
      return undefined;
    }

    const symbol = resolvedReferenceSymbol(this.checker, reference);
    const declarations = resolvedSymbolDeclarations(this.checker, symbol);

    if (declarations.length > 0 && symbol !== undefined) {
      return { declarations, symbol };
    }

    if (!isStandardReference(reference, this.reserveTraversalNode)) {
      this.candidates.push({ target: reference.target });
    }

    return undefined;
  }

  inspectNode(node: Node): CompilerSymbol | undefined {
    if (directNodeReference(node)) {
      this.directReference = true;
      const candidate = directNodeReferenceCandidate(node);

      if (candidate !== undefined) {
        this.candidates.push({ target: candidate });
      }
    }

    return this.inspectReference(node)?.symbol;
  }

  inspectTypeNode(node: Node): readonly Declaration[] {
    const candidate = directNodeReferenceCandidate(node);

    if (directNodeReference(node) && candidate !== undefined) {
      this.candidates.push({ target: candidate });
    }

    return this.inspectReference(node)?.declarations ?? [];
  }

  inspectValueNode(node: Node): readonly Declaration[] {
    if (!isIdentifier(node) || !isValueReferenceIdentifier(node)) {
      return [];
    }

    const target = valueReferenceTarget(node);
    const symbol = symbolAtLocation(this.checker, target);
    const declarations = resolvedSymbolDeclarations(this.checker, symbol);

    if (declarations.length > 0) {
      return declarations;
    }

    if (!isStandardValueReference(target, node, this.reserveTraversalNode)) {
      this.candidates.push({ target });
    }

    return [];
  }

  recordComputedName(expression: Expression): void {
    if (!isRepresentableComputedName(this.checker, expression)) {
      this.computedNames.push(expression);
    }
  }

  selectProvider(
    createProviderProgram: () => NodeProviderProgram | undefined
  ): Program | undefined {
    if (
      !this.directReference &&
      this.candidates.length === 0 &&
      this.computedNames.length === 0
    ) {
      return undefined;
    }

    const provider = createProviderProgram();

    if (provider === undefined) {
      throw this.computedNames.length > 0
        ? unrepresentableComputedName()
        : unresolvedGlobalReference();
    }

    if (providerDefinesCandidates(provider, this.candidates)) {
      const providerChecker = provider.program.getProject().checker;

      if (
        this.computedNames.every((expression) =>
          isRepresentableComputedName(providerChecker, expression)
        )
      ) {
        return provider.program;
      }

      throw unrepresentableComputedName();
    }

    throw unresolvedGlobalReference();
  }
}
