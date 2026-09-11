import ts from "@typescript/typescript6";
import { builtinModules } from "node:module";

import {
  isPublicProjectionChild,
  publicDeclarations,
} from "#typepeek/inspection/declaration-projection";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isPathWithin } from "#typepeek/inspection/evidence-boundary";
import { readStandardGlobalCatalog } from "#typepeek/inspection/standard-global-catalog";
import { isWellKnownSymbolMemberName } from "#typepeek/inspection/well-known-symbol";

const MAX_DECLARATION_GRAPH_DEPTH = 256;
const NODE_PLATFORM_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ),
]);
interface StandardGlobalSpaces {
  type: boolean;
  value: boolean;
}

let standardGlobalNames: ReadonlyMap<string, StandardGlobalSpaces> | undefined;
const computedNamesByChecker = new WeakMap<ts.TypeChecker, ts.Expression[]>();

export interface NodeProviderProgram {
  readonly program: ts.Program;
  readonly providerRoot: string;
}

interface GlobalCandidate {
  readonly target: ts.Node;
}

interface InferenceScanState {
  readonly visitedDeclarations: Set<ts.Declaration>;
}

export function isNodePlatformSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") && specifier.length > "node:".length;
}

export function isKnownNodePlatformSpecifier(specifier: string): boolean {
  return NODE_PLATFORM_SPECIFIERS.has(specifier);
}

/** Loads the visible Node Declaration Provider when the selected declarations reference it. */
export function selectNodeDeclarationProgram(
  initialProgram: ts.Program,
  initialModuleSymbol: ts.Symbol,
  entrypoint: ts.SourceFile,
  createProviderProgram: () => NodeProviderProgram | undefined,
  reserveTraversalNode: () => void,
  selectedExportNames?: ReadonlySet<string>,
): ts.Program | undefined {
  const { candidates, computedNames, directReference } = inspectInitialPublicInterface(
    initialProgram,
    initialModuleSymbol,
    entrypoint,
    reserveTraversalNode,
    selectedExportNames,
  );
  if (!directReference && candidates.length === 0 && computedNames.length === 0) {
    return undefined;
  }
  const provider = createProviderProgram();
  if (provider === undefined) {
    throw computedNames.length > 0 ? unrepresentableComputedName() : unresolvedGlobalReference();
  }
  if (providerDefinesCandidates(provider, candidates)) {
    const providerChecker = provider.program.getTypeChecker();
    if (
      computedNames.every((expression) => isRepresentableComputedName(providerChecker, expression))
    ) {
      return provider.program;
    }
    throw unrepresentableComputedName();
  }
  throw unresolvedGlobalReference();
}

function inspectInitialPublicInterface(
  program: ts.Program,
  moduleSymbol: ts.Symbol,
  entrypoint: ts.SourceFile,
  reserveTraversalNode: () => void,
  selectedExportNames: ReadonlySet<string> | undefined,
): {
  readonly candidates: readonly GlobalCandidate[];
  readonly computedNames: readonly ts.Expression[];
  readonly directReference: boolean;
} {
  const checker = program.getTypeChecker();
  const candidates: GlobalCandidate[] = [];
  const computedNames: ts.Expression[] = [];
  computedNamesByChecker.set(checker, computedNames);
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  const pendingSymbols =
    selectedExportNames === undefined
      ? [...moduleExports]
      : moduleExports.filter((symbol) => selectedExportNames.has(symbol.getName()));
  const pendingNodes: ts.Node[] = [
    ...(selectedExportNames === undefined ? exportedStatements(checker, entrypoint) : []),
    ...(moduleSymbol.declarations ?? []).filter(ts.isModuleDeclaration),
    entrypoint,
  ];
  const visitedSymbols = new Set<ts.Symbol>();
  const visitedNodes = new Set<ts.Node>();
  let pendingSymbolIndex = 0;
  let pendingNodeIndex = 0;
  let directReference = false;

  while (pendingSymbolIndex < pendingSymbols.length || pendingNodeIndex < pendingNodes.length) {
    if (pendingSymbolIndex < pendingSymbols.length) {
      const pendingSymbol = pendingSymbols[pendingSymbolIndex];
      pendingSymbolIndex += 1;
      enqueueSymbolDeclarations(
        checker,
        pendingSymbol,
        pendingSymbols,
        pendingNodes,
        visitedSymbols,
      );
    }
    const root = pendingNodes[pendingNodeIndex];
    if (pendingNodeIndex < pendingNodes.length) {
      pendingNodeIndex += 1;
    }
    if (root === undefined || visitedNodes.has(root)) {
      continue;
    }
    visitedNodes.add(root);
    directReference =
      scanPublicDeclaration({
        candidates,
        checker,
        pendingNodes,
        pendingSymbols,
        reserveTraversalNode,
        root,
        selectedExportNames,
      }) || directReference;
  }
  return { candidates, computedNames, directReference };
}

function directNodeReference(node: ts.Node): boolean {
  if (
    ts.isSourceFile(node) &&
    node.typeReferenceDirectives.some(({ fileName }) => fileName === "node")
  ) {
    return true;
  }
  const specifier = referencedModuleSpecifier(node);
  return specifier !== undefined && isKnownNodePlatformSpecifier(specifier);
}

function providerDefinesCandidates(
  provider: NodeProviderProgram,
  candidates: readonly GlobalCandidate[],
): boolean {
  const checker = provider.program.getTypeChecker();
  return candidates.every(({ target }) => {
    const symbol = checker.getSymbolAtLocation(target);
    return resolvedSymbolDeclarations(checker, symbol).some((declaration) =>
      isPathWithin(provider.providerRoot, declaration.getSourceFile().fileName),
    );
  });
}

function resolvedSymbolDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): readonly ts.Declaration[] {
  if (symbol === undefined) {
    return [];
  }
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return publicDeclarations(checker, resolved.declarations ?? []);
}

function enqueueSymbolDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  pendingSymbols: ts.Symbol[],
  pendingNodes: ts.Node[],
  visitedSymbols: Set<ts.Symbol>,
): void {
  if (symbol === undefined || visitedSymbols.has(symbol)) {
    return;
  }
  visitedSymbols.add(symbol);
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (resolved !== symbol && !visitedSymbols.has(resolved)) {
    pendingSymbols.push(resolved);
  }
  for (const declaration of publicDeclarations(checker, symbol.declarations ?? [])) {
    pendingNodes.push(declaration);
    const moduleReference = enclosingModuleReference(declaration);
    if (moduleReference !== undefined) {
      pendingNodes.push(moduleReference);
    }
  }
}

function inspectReferencedSymbol(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly pendingSymbols: ts.Symbol[];
    readonly reserveTraversalNode: () => void;
  },
  node: ts.Node,
): void {
  const reference = possibleGlobalReference(node);
  if (reference === undefined) {
    return;
  }
  const symbol = resolvedReferenceSymbol(options.checker, reference);
  if (resolvedSymbolDeclarations(options.checker, symbol).length > 0) {
    if (symbol !== undefined) {
      options.pendingSymbols.push(symbol);
    }
    return;
  }
  if (!isStandardReference(reference, options.reserveTraversalNode)) {
    options.candidates.push({ target: reference.target });
  }
}

function resolvedReferenceSymbol(
  checker: ts.TypeChecker,
  reference: NonNullable<ReturnType<typeof possibleGlobalReference>>,
): ts.Symbol | undefined {
  const targetSymbol = checker.getSymbolAtLocation(reference.target);
  if (resolvedSymbolDeclarations(checker, targetSymbol).length > 0) {
    return targetSymbol;
  }
  const rootSymbol = checker.getSymbolAtLocation(reference.root);
  return resolvedSymbolDeclarations(checker, rootSymbol).length > 0 ? rootSymbol : targetSymbol;
}

function enqueueModuleExports(
  checker: ts.TypeChecker,
  node: ts.Node,
  pendingNodes: ts.Node[],
  pendingSymbols: ts.Symbol[],
  selectedExportNames: ReadonlySet<string> | undefined,
): void {
  if (!ts.isModuleDeclaration(node)) {
    return;
  }
  const symbol = checker.getSymbolAtLocation(node.name);
  const nestedExportNames = ts.isStringLiteralLike(node.name) ? selectedExportNames : undefined;
  if (symbol !== undefined) {
    const exports = checker.getExportsOfModule(symbol);
    pendingSymbols.push(
      ...(nestedExportNames === undefined
        ? exports
        : exports.filter((symbol) => nestedExportNames.has(symbol.getName()))),
    );
  }
  const body = node.body;
  if (body !== undefined && ts.isModuleBlock(body)) {
    if (nestedExportNames === undefined) {
      pendingNodes.push(...exportedStatements(checker, body));
    }
  }
}

function exportedStatements(
  checker: ts.TypeChecker,
  container: ts.SourceFile | ts.ModuleBlock,
): readonly ts.Statement[] {
  const exported = container.statements.filter(isExportedStatement);
  const publicFunctions = new Set(
    publicDeclarations(checker, exported.filter(ts.isFunctionDeclaration)),
  );
  return exported.filter(
    (statement) => !ts.isFunctionDeclaration(statement) || publicFunctions.has(statement),
  );
}

function isExportedStatement(statement: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
  );
}

function enclosingModuleReference(declaration: ts.Declaration): ts.Node | undefined {
  let current: ts.Node = declaration;
  while (!ts.isSourceFile(current)) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

declare const __TYPEPEEK_STANDARD_GLOBALS__: import("#typepeek/inspection/standard-global-catalog").StandardGlobalCatalog;
const embeddedStandardGlobals =
  typeof __TYPEPEEK_STANDARD_GLOBALS__ === "undefined" ? undefined : __TYPEPEEK_STANDARD_GLOBALS__;

function standardGlobals(
  reserveTraversalNode: () => void,
): ReadonlyMap<string, StandardGlobalSpaces> {
  if (standardGlobalNames !== undefined) return standardGlobalNames;
  const catalog =
    embeddedStandardGlobals?.compilerVersion === ts.version
      ? embeddedStandardGlobals
      : readStandardGlobalCatalog();
  for (let index = 0; index < catalog.traversalNodes; index += 1) reserveTraversalNode();
  standardGlobalNames = new Map(
    catalog.entries.map(([name, spaces]) => [
      name,
      { type: (spaces & 1) !== 0, value: (spaces & 2) !== 0 },
    ]),
  );
  return standardGlobalNames;
}

function isStandardGlobal(
  name: string,
  space: "type" | "value",
  reserveTraversalNode: () => void,
): boolean {
  return standardGlobals(reserveTraversalNode).get(name)?.[space] === true;
}

function isStandardReference(
  reference: NonNullable<ReturnType<typeof possibleGlobalReference>>,
  reserveTraversalNode: () => void,
): boolean {
  const path = standardReferencePath(reference.target);
  if (path === undefined || path.length === 0) {
    return false;
  }
  if (isWellKnownSymbolReference(path, reference.space)) {
    return true;
  }
  return standardGlobals(reserveTraversalNode).get(path.join("."))?.[reference.space] === true;
}

function standardReferencePath(target: ts.Node): readonly string[] | undefined {
  const path = referencePath(target);
  return path?.[0] === "globalThis" && path.length > 1 ? path.slice(1) : path;
}

function isWellKnownSymbolReference(path: readonly string[], space: "type" | "value"): boolean {
  return (
    space === "value" &&
    path.length === 2 &&
    path[0] === "Symbol" &&
    isWellKnownSymbolMemberName(path[1] ?? "")
  );
}

function referencePath(node: ts.Node): string[] | undefined {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  if (ts.isQualifiedName(node)) {
    const left = referencePath(node.left);
    return left === undefined ? undefined : [...left, node.right.text];
  }
  if (ts.isPropertyAccessExpression(node)) {
    const expression = referencePath(node.expression);
    return expression === undefined ? undefined : [...expression, node.name.text];
  }
  return undefined;
}

function possibleGlobalReference(node: ts.Node):
  | {
      readonly root: ts.Identifier;
      readonly space: "type" | "value";
      readonly target: ts.Node;
    }
  | undefined {
  if (ts.isTypeReferenceNode(node)) {
    if (isConstAssertionType(node)) {
      return undefined;
    }
    const root = entityNameRoot(node.typeName);
    return { root, space: "type", target: node.typeName };
  }
  if (ts.isTypeQueryNode(node)) {
    const root = entityNameRoot(node.exprName);
    return { root, space: "value", target: node.exprName };
  }
  if (ts.isExpressionWithTypeArguments(node)) {
    const root = expressionRoot(node.expression);
    return root === undefined ? undefined : { root, space: "type", target: node.expression };
  }
  return undefined;
}

function isConstAssertionType(node: ts.TypeReferenceNode): boolean {
  if (!ts.isIdentifier(node.typeName) || node.typeName.text !== "const") {
    return false;
  }
  const { parent } = node;
  return (
    (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) && parent.type === node
  );
}

function entityNameRoot(name: ts.EntityName): ts.Identifier {
  let current = name;
  while (ts.isQualifiedName(current)) {
    current = current.left;
  }
  return current;
}

function expressionRoot(expression: ts.Expression): ts.Identifier | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function scanPublicDeclaration(options: {
  readonly candidates: GlobalCandidate[];
  readonly checker: ts.TypeChecker;
  readonly pendingNodes: ts.Node[];
  readonly pendingSymbols: ts.Symbol[];
  readonly reserveTraversalNode: () => void;
  readonly root: ts.Node;
  readonly selectedExportNames: ReadonlySet<string> | undefined;
}): boolean {
  let found = false;
  const visit = (node: ts.Node, depth: number): void => {
    options.reserveTraversalNode();
    if (depth > MAX_DECLARATION_GRAPH_DEPTH) {
      throw new InspectionLimitError(
        "declaration-graph",
        "Inspection exceeded its declaration graph traversal limit.",
      );
    }
    if (directNodeReference(node)) {
      found = true;
      const candidate = directNodeReferenceCandidate(node);
      if (candidate !== undefined) {
        options.candidates.push({ target: candidate });
      }
    }
    inspectReferencedSymbol(options, node);
    inspectInferredPublicType(options, node, depth);
    if (ts.isComputedPropertyName(node)) {
      recordComputedName(options.checker, node.expression);
      scanInferenceExpression(options, node.expression, depth + 1, inferenceScanState());
    }
    enqueueModuleExports(
      options.checker,
      node,
      options.pendingNodes,
      options.pendingSymbols,
      options.selectedExportNames,
    );
    ts.forEachChild(node, (child) => {
      if (isPublicProjectionChild(options.checker, node, child)) {
        visit(child, depth + 1);
      }
    });
  };
  if (ts.isSourceFile(options.root)) {
    options.reserveTraversalNode();
    return options.root.typeReferenceDirectives.some(({ fileName }) => fileName === "node");
  }
  visit(options.root, 0);
  return found;
}

function directNodeReferenceCandidate(node: ts.Node): ts.Node | undefined {
  if (!ts.isImportTypeNode(node)) {
    return undefined;
  }
  if (node.qualifier !== undefined) {
    return node.qualifier;
  }
  return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
}

function inspectInferredPublicType(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  node: ts.Node,
  depth: number,
): void {
  inspectInferredPublicNode(options, node, depth, inferenceScanState());
}

function inspectInferredPublicNode(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  node: ts.Node,
  depth: number,
  state: InferenceScanState,
): void {
  if (hasInferredInitializerType(node) && node.initializer !== undefined) {
    scanInferenceExpression(options, node.initializer, depth + 1, state);
  }
  if (hasInferredPublicReturn(node)) {
    scanInferredFunctionBody(options, node.body, depth + 1, state);
  }
}

function hasInferredPublicReturn(node: ts.Node): node is (
  | ts.FunctionDeclaration
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
) & {
  readonly body: ts.Block;
} {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node)) &&
    node.type === undefined &&
    node.body !== undefined
  );
}

function hasInferredInitializerType(
  node: ts.Node,
): node is
  | ts.BindingElement
  | ts.ParameterDeclaration
  | ts.PropertyDeclaration
  | ts.VariableDeclaration {
  if (ts.isBindingElement(node)) {
    return true;
  }
  return (
    (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) &&
    node.type === undefined
  );
}

function scanInferredFunctionBody(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  body: ts.ConciseBody,
  depth: number,
  state: InferenceScanState,
): void {
  if (!ts.isBlock(body)) {
    scanInferenceExpression(options, body, depth, state);
    return;
  }
  const visit = (node: ts.Node, currentDepth: number): void => {
    options.reserveTraversalNode();
    assertDeclarationGraphDepth(currentDepth);
    if (ts.isFunctionLike(node) && node !== body.parent) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      scanInferenceExpression(options, node.expression, currentDepth + 1, state);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, currentDepth + 1));
  };
  visit(body, depth);
}

function scanInferenceExpression(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  expression: ts.Expression,
  depth: number,
  state: InferenceScanState,
): void {
  const visit = (node: ts.Node, currentDepth: number): void => {
    options.reserveTraversalNode();
    assertDeclarationGraphDepth(currentDepth);
    if (ts.isTypeNode(node)) {
      scanInferenceTypeNode(options, node, currentDepth + 1, state);
      return;
    }
    if (ts.isComputedPropertyName(node)) {
      recordComputedName(options.checker, node.expression);
      scanInferenceExpression(options, node.expression, currentDepth + 1, state);
      return;
    }
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      scanInferredFunctionBody(options, node.body, currentDepth + 1, state);
      return;
    }
    inspectInferenceNode(options, node, currentDepth, state);
    ts.forEachChild(node, (child) => visit(child, currentDepth + 1));
  };
  visit(expression, depth);
}

function inspectInferenceNode(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  node: ts.Node,
  depth: number,
  state: InferenceScanState,
): void {
  if (!ts.isIdentifier(node) || !isValueReferenceIdentifier(node)) {
    return;
  }
  const target = valueReferenceTarget(node);
  const symbol = options.checker.getSymbolAtLocation(target);
  const declarations = resolvedSymbolDeclarations(options.checker, symbol);
  if (declarations.length > 0) {
    for (const declaration of declarations) {
      scanInferenceDeclaration(options, declaration, depth + 1, state);
    }
    return;
  }
  if (isStandardValueReference(target, node, options.reserveTraversalNode)) {
    return;
  }
  options.candidates.push({ target });
}

function isStandardValueReference(
  target: ts.Expression,
  root: ts.Identifier,
  reserveTraversalNode: () => void,
): boolean {
  if (!isStandardGlobal(root.text, "value", reserveTraversalNode)) {
    return false;
  }
  if (target === root) {
    return true;
  }
  return isTrustedStandardValueMember(target, root);
}

function isTrustedStandardValueMember(target: ts.Expression, root: ts.Identifier): boolean {
  if (!ts.isPropertyAccessExpression(target) || target.expression !== root) {
    return false;
  }
  const globalValue = Object.getOwnPropertyDescriptor(globalThis, root.text)?.value as unknown;
  return (
    (typeof globalValue === "function" ||
      (typeof globalValue === "object" && globalValue !== null)) &&
    Object.getOwnPropertyDescriptor(globalValue, target.name.text) !== undefined
  );
}

function recordComputedName(checker: ts.TypeChecker, expression: ts.Expression): void {
  if (!isRepresentableComputedName(checker, expression)) {
    computedNamesByChecker.get(checker)?.push(expression);
  }
}

function isRepresentableComputedName(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    isStandardSymbolMember(expression)
  ) {
    return true;
  }
  const flags = checker.getTypeAtLocation(expression).flags;
  if (
    flags & ts.TypeFlags.UniqueESSymbol ||
    flags & ts.TypeFlags.StringLiteral ||
    flags & ts.TypeFlags.NumberLiteral
  ) {
    return true;
  }
  return false;
}

function unrepresentableComputedName(): UnsupportedInspectionError {
  return new UnsupportedInspectionError(
    "A computed Public Interface name cannot be represented statically.",
  );
}

function isStandardSymbolMember(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Symbol" &&
    isWellKnownSymbolMemberName(expression.name.text)
  );
}

function inferenceScanState(): InferenceScanState {
  return { visitedDeclarations: new Set() };
}

function scanInferenceDeclaration(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  declaration: ts.Declaration,
  depth: number,
  state: InferenceScanState,
): void {
  if (state.visitedDeclarations.has(declaration)) {
    return;
  }
  state.visitedDeclarations.add(declaration);
  options.reserveTraversalNode();
  assertDeclarationGraphDepth(depth);
  scanInferenceDeclarationSyntax(options, declaration, depth + 1, state);
}

function scanInferenceDeclarationSyntax(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  declaration: ts.Declaration,
  depth: number,
  state: InferenceScanState,
): void {
  const visit = (node: ts.Node, currentDepth: number): void => {
    options.reserveTraversalNode();
    assertDeclarationGraphDepth(currentDepth);
    inspectInferredPublicNode(options, node, currentDepth, state);
    if (ts.isTypeNode(node)) {
      scanInferenceTypeNode(options, node, currentDepth + 1, state);
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      const body = node.body;
      if (body !== undefined && ts.isModuleBlock(body)) {
        for (const statement of exportedStatements(options.checker, body)) {
          visit(statement, currentDepth + 1);
        }
      }
      return;
    }
    ts.forEachChild(node, (child) => {
      if (isPublicProjectionChild(options.checker, node, child)) {
        visit(child, currentDepth + 1);
      }
    });
  };
  visit(declaration, depth);
}

function scanInferenceTypeNode(
  options: {
    readonly candidates: GlobalCandidate[];
    readonly checker: ts.TypeChecker;
    readonly reserveTraversalNode: () => void;
  },
  typeNode: ts.TypeNode,
  depth: number,
  state: InferenceScanState,
): void {
  const visit = (node: ts.Node, currentDepth: number): void => {
    options.reserveTraversalNode();
    assertDeclarationGraphDepth(currentDepth);
    const directCandidate = directNodeReferenceCandidate(node);
    if (directNodeReference(node) && directCandidate !== undefined) {
      options.candidates.push({ target: directCandidate });
    }
    const reference = possibleGlobalReference(node);
    if (reference !== undefined) {
      const symbol = resolvedReferenceSymbol(options.checker, reference);
      const declarations = resolvedSymbolDeclarations(options.checker, symbol);
      if (declarations.length > 0) {
        for (const declaration of declarations) {
          scanInferenceDeclaration(options, declaration, currentDepth + 1, state);
        }
      } else if (!isStandardReference(reference, options.reserveTraversalNode)) {
        options.candidates.push({ target: reference.target });
      }
    }
    ts.forEachChild(node, (child) => visit(child, currentDepth + 1));
  };
  visit(typeNode, depth);
}

function valueReferenceTarget(identifier: ts.Identifier): ts.Expression {
  let current: ts.Expression = identifier;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    current = current.parent;
  }
  return current;
}

function isValueReferenceIdentifier(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
      parent.name === identifier)
  );
}

function assertDeclarationGraphDepth(depth: number): void {
  if (depth > MAX_DECLARATION_GRAPH_DEPTH) {
    throw new InspectionLimitError(
      "declaration-graph",
      "Inspection exceeded its declaration graph traversal limit.",
    );
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(({ kind: found }) => found === kind) === true
  );
}

function unresolvedGlobalReference(): UnsupportedInspectionError {
  return new UnsupportedInspectionError(
    "A declaration contains an unresolved global reference without an authoritative visible Declaration Provider.",
  );
}

function referencedModuleSpecifier(node: ts.Node): string | undefined {
  return (
    importOrExportSpecifier(node) ??
    importEqualsSpecifier(node) ??
    importTypeSpecifier(node) ??
    ambientModuleSpecifier(node)
  );
}

function importOrExportSpecifier(node: ts.Node): string | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
    return undefined;
  }
  return node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

function importEqualsSpecifier(node: ts.Node): string | undefined {
  if (!ts.isImportEqualsDeclaration(node) || !ts.isExternalModuleReference(node.moduleReference)) {
    return undefined;
  }
  const expression = node.moduleReference.expression;
  return expression !== undefined && ts.isStringLiteralLike(expression)
    ? expression.text
    : undefined;
}

function importTypeSpecifier(node: ts.Node): string | undefined {
  if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument)) {
    return undefined;
  }
  return ts.isStringLiteralLike(node.argument.literal) ? node.argument.literal.text : undefined;
}

function ambientModuleSpecifier(node: ts.Node): string | undefined {
  return ts.isModuleDeclaration(node) && ts.isStringLiteralLike(node.name)
    ? node.name.text
    : undefined;
}
