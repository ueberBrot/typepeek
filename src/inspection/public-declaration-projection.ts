import ts from "@typescript/typescript6";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/typescript-standard-library";
import { isWellKnownSymbolMemberName } from "#typepeek/inspection/well-known-symbol";

const INFERRED_TYPE_FLAGS = ts.NodeBuilderFlags.NoTruncation;
const MEMBER_TYPE_QUERY_FLAGS =
  INFERRED_TYPE_FLAGS |
  ts.NodeBuilderFlags.UseStructuralFallback |
  ts.NodeBuilderFlags.WriteClassExpressionAsTypeLiteral;
const MAX_INFERRED_TYPE_TRAVERSAL_DEPTH = 64;
const MAX_INFERRED_TYPE_TRAVERSAL_NODES = 4_096;
const MEMBER_CONTAINER_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.TypeLiteral,
]);
const NAMESPACE_DECLARATION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);
const INFERRED_DECLARATION_TYPE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.Parameter,
]);
const INFERRED_RETURN_TYPE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
]);

export interface PublicDeclarationProjection {
  readonly inferredTypes: readonly ts.Type[];
  readonly syntax: ts.Declaration;
}

export interface PublicDeclarationProjectionContext {
  readonly moduleSymbol: ts.Symbol;
  readonly reserveTraversal: (depth: number) => void;
  readonly reserveTypeTraversal: (depth: number) => void;
  readonly validatedTypes: Set<ts.Type>;
}

/** Projects one declaration onto the semantic Public Interface consumed by every adapter. */
export function projectPublicDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  context: PublicDeclarationProjectionContext = standaloneProjectionContext(checker, declaration),
): PublicDeclarationProjection {
  return {
    get inferredTypes() {
      return inferredPublicTypes(checker, declaration, context);
    },
    get syntax() {
      return publicDeclarationSyntax(checker, declaration, context);
    },
  };
}

function publicDeclarationSyntax(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  context: PublicDeclarationProjectionContext,
): ts.Declaration {
  return projectMemberTypeQueries(
    checker,
    publicDeclarationSyntaxBeforeMemberTypeQueries(checker, declaration, context),
    context,
  );
}

function publicDeclarationSyntaxBeforeMemberTypeQueries(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  context: PublicDeclarationProjectionContext,
): ts.Declaration {
  const printableDeclaration = ts.isNamespaceExport(declaration) ? declaration.parent : declaration;
  return publicDeclaration(checker, printableDeclaration, context);
}

/** Identifies declaration nodes that cannot contribute to a Public Interface. */
export function isPrivateDeclaration(node: ts.Node): boolean {
  return (
    hasPrivateIdentifier(node) ||
    (hasPrivateModifier(node) && !isConstructorParameterProperty(node))
  );
}

/** Selects exactly the source children that can contribute to the projected Public Interface. */
export function isPublicProjectionChild(
  checker: ts.TypeChecker,
  parent: ts.Node,
  child: ts.Node,
): boolean {
  return !(
    isDiscardedProjectionSyntax(child) ||
    isUnprojectedConstructorChild(checker, parent, child) ||
    isNonPublicClassProjectionChild(checker, parent, child) ||
    isProjectionFunctionBody(parent, child) ||
    isProjectionInitializer(parent, child)
  );
}

/** Removes source overload implementations from the declarations visible to callers. */
export function publicDeclarations(
  checker: ts.TypeChecker,
  declarations: readonly ts.Declaration[],
): readonly ts.Declaration[] {
  return withoutOverloadImplementations(checker, declarations);
}

/** Returns checker types synthesized into a source-backed Public Interface. */
function inferredPublicTypes(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  context: PublicDeclarationProjectionContext,
): readonly ts.Type[] {
  const types: ts.Type[] = [];
  collectInferredPublicTypes(checker, declaration, types);
  collectMemberTypeQueryTypes(
    checker,
    publicDeclarationSyntaxBeforeMemberTypeQueries(checker, declaration, context),
    types,
    context,
    0,
  );
  return types;
}

function projectMemberTypeQueries(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  projectionContext: PublicDeclarationProjectionContext,
): ts.Declaration {
  const transformation = ts.transform<ts.Declaration>(declaration, [
    (context) => {
      const visit = (node: ts.Node, depth: number): ts.VisitResult<ts.Node> => {
        projectionContext.reserveTraversal(depth);
        return isMemberTypeQuery(checker, node, projectionContext)
          ? resolvedMemberTypeNode(checker, node, projectionContext)
          : ts.visitEachChild(node, (child) => visit(child, depth + 1), context);
      };
      return (root) => ts.visitNode(root, (node) => visit(node, 0)) as ts.Declaration;
    },
  ]);
  try {
    return transformation.transformed[0] ?? declaration;
  } finally {
    transformation.dispose();
  }
}

function isMemberTypeQuery(
  checker: ts.TypeChecker,
  node: ts.Node,
  context: PublicDeclarationProjectionContext,
): node is ts.TypeQueryNode {
  if (!ts.isTypeQueryNode(node)) {
    return false;
  }
  if (isWellKnownSymbolTypeQuery(checker, node)) {
    return false;
  }
  const symbol = resolvedSymbolAtLocation(checker, node.exprName);
  const declarations = symbol?.declarations ?? [];
  if (
    declarations.some(
      (declaration) =>
        !isTypeScriptStandardLibraryDeclaration(declaration.getSourceFile().fileName) &&
        declarationOwnerIsMember(
          checker,
          context.moduleSymbol,
          declaration,
          context.reserveTraversal,
        ),
    )
  ) {
    return true;
  }
  return ts.isQualifiedName(node.exprName) && !declarationsAreStandardLibrary(declarations);
}

function resolvedMemberTypeNode(
  checker: ts.TypeChecker,
  query: ts.TypeQueryNode,
  context: PublicDeclarationProjectionContext,
): ts.TypeNode {
  const exactStandardLibraryQuery = exactStandardLibraryMemberTypeQuery(checker, query);
  if (exactStandardLibraryQuery !== undefined) {
    return exactStandardLibraryQuery;
  }
  const type = checker.getTypeAtLocation(query.exprName);
  assertNoImplementationLocalType(checker, type, context);
  assertMemberTypeSymbolIsRepresentable(checker, type, context);
  const typeNode = checker.typeToTypeNode(type, query, MEMBER_TYPE_QUERY_FLAGS);
  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(
      "A Member type query could not be represented independently.",
    );
  }
  if (!memberTypeHasExplicitDeclaration(checker, query)) {
    assertReliableInferredType(typeNode, context);
  }
  const allowsStandardLibraryTypeQuery = declarationsAreStandardLibrary(
    (type.aliasSymbol ?? type.getSymbol())?.declarations ?? [],
  );
  if (containsTypeQuery(typeNode, context, allowsStandardLibraryTypeQuery, 0)) {
    throw new UnsupportedInspectionError(
      "A Member type query could not be represented independently.",
    );
  }
  return typeNode;
}

function assertMemberTypeSymbolIsRepresentable(
  checker: ts.TypeChecker,
  type: ts.Type,
  context: PublicDeclarationProjectionContext,
): void {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (
    symbol !== undefined &&
    symbol.declarations?.some(
      (declaration) =>
        (isNamedTypeDeclarationSyntax(declaration) || ts.isEnumMember(declaration)) &&
        declarationOwnerIsMember(
          checker,
          context.moduleSymbol,
          declaration,
          context.reserveTraversal,
        ),
    ) === true
  ) {
    throw new UnsupportedInspectionError(
      "A Member type query could not be represented independently.",
    );
  }
}

/** Identifies declarations owned by a Member rather than the selected Inspectable Module. */
export function declarationOwnerIsMember(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  declaration: ts.Declaration,
  reserveTraversal: (depth: number) => void,
): boolean {
  let ancestor = declaration.parent;
  for (let depth = 0; ancestor !== undefined; depth += 1, ancestor = ancestor.parent) {
    reserveTraversal(depth);
    if (ts.isSourceFile(ancestor)) {
      return false;
    }
    if (ts.isModuleBlock(ancestor)) {
      return checker.getSymbolAtLocation(ancestor.parent.name) !== moduleSymbol;
    }
    if (MEMBER_CONTAINER_KINDS.has(ancestor.kind)) {
      return true;
    }
  }
  return false;
}

function containsTypeQuery(
  node: ts.Node,
  context: PublicDeclarationProjectionContext,
  allowsStandardLibraryTypeQuery: boolean,
  depth: number,
): boolean {
  context.reserveTraversal(depth);
  if (ts.isTypeQueryNode(node)) {
    return !allowsStandardLibraryTypeQuery;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    found ||= containsTypeQuery(child, context, allowsStandardLibraryTypeQuery, depth + 1);
  });
  return found;
}

function collectMemberTypeQueryTypes(
  checker: ts.TypeChecker,
  node: ts.Node,
  types: ts.Type[],
  context: PublicDeclarationProjectionContext,
  depth: number,
): void {
  context.reserveTraversal(depth);
  if (isMemberTypeQuery(checker, node, context)) {
    if (exactStandardLibraryMemberTypeQuery(checker, node) === undefined) {
      types.push(checker.getTypeAtLocation(node.exprName));
    }
    return;
  }
  ts.forEachChild(node, (child) =>
    collectMemberTypeQueryTypes(checker, child, types, context, depth + 1),
  );
}

function resolvedSymbolAtLocation(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declarationsAreStandardLibrary(declarations: readonly ts.Declaration[]): boolean {
  return (
    declarations.length > 0 &&
    declarations.every((declaration) =>
      isTypeScriptStandardLibraryDeclaration(declaration.getSourceFile().fileName),
    )
  );
}

function memberTypeHasExplicitDeclaration(
  checker: ts.TypeChecker,
  query: ts.TypeQueryNode,
): boolean {
  const symbol = resolvedSymbolAtLocation(checker, query.exprName);
  return symbol?.declarations?.some(declarationHasExplicitType) === true;
}

function exactStandardLibraryMemberTypeQuery(
  checker: ts.TypeChecker,
  query: ts.TypeQueryNode,
): ts.TypeQueryNode | undefined {
  const symbol = resolvedSymbolAtLocation(checker, query.exprName);
  return symbol?.declarations
    ?.map(explicitDeclarationType)
    .find(
      (typeNode): typeNode is ts.TypeQueryNode =>
        typeNode !== undefined &&
        ts.isTypeQueryNode(typeNode) &&
        standardLibraryTypeQueryIsAuthoritative(checker, typeNode),
    );
}

function standardLibraryTypeQueryIsAuthoritative(
  checker: ts.TypeChecker,
  typeQuery: ts.TypeQueryNode,
): boolean {
  const typeSymbol = resolvedSymbolAtLocation(checker, typeQuery.exprName);
  return (
    declarationsAreStandardLibrary(typeSymbol?.declarations ?? []) ||
    isWellKnownSymbolTypeQuery(checker, typeQuery)
  );
}

function isWellKnownSymbolTypeQuery(checker: ts.TypeChecker, node: ts.TypeQueryNode): boolean {
  if (
    !ts.isQualifiedName(node.exprName) ||
    !ts.isIdentifier(node.exprName.left) ||
    node.exprName.left.text !== "Symbol" ||
    !isWellKnownSymbolMemberName(node.exprName.right.text)
  ) {
    return false;
  }
  const rootSymbol = resolvedSymbolAtLocation(checker, node.exprName.left);
  return rootSymbol === undefined || declarationsAreStandardLibrary(rootSymbol.declarations ?? []);
}

function declarationHasExplicitType(declaration: ts.Declaration): boolean {
  return explicitDeclarationType(declaration) !== undefined || ts.isEnumMember(declaration);
}

function standaloneProjectionContext(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): PublicDeclarationProjectionContext {
  const moduleSymbol = checker.getSymbolAtLocation(declaration.getSourceFile());
  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "A public declaration could not be related to its Inspectable Module.",
    );
  }
  const traversal = { nodeCount: 0 };
  const typeTraversal = { nodeCount: 0 };
  return {
    moduleSymbol,
    reserveTraversal: (depth) => reserveInferredTypeSyntaxTraversal(traversal, depth),
    reserveTypeTraversal: (depth) => reserveInferredTypeSyntaxTraversal(typeTraversal, depth),
    validatedTypes: new Set(),
  };
}

/** Returns only type edges that can contribute to a nameable Public Interface. */
export function inferredPublicTypeChildren(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] {
  const publicChildren = [...compositeTypeChildren(type), ...genericTypeChildren(checker, type)];
  return hasNamedTypeSurface(type)
    ? publicChildren
    : [
        ...publicChildren,
        ...signatureTypeChildren(checker, type),
        ...propertyTypeChildren(checker, type),
      ];
}

function publicDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  context: PublicDeclarationProjectionContext,
): ts.Declaration {
  if (ts.isExportAssignment(declaration) && !declaration.getSourceFile().isDeclarationFile) {
    throw new UnsupportedInspectionError(
      "A source-backed default expression cannot be represented without implementation.",
    );
  }
  if (ts.isFunctionDeclaration(declaration)) {
    assertRepresentableAsyncDeclaration(declaration);
    return ts.factory.updateFunctionDeclaration(
      declaration,
      publicModifiers(declaration.modifiers),
      declaration.asteriskToken,
      declaration.name,
      declaration.typeParameters,
      declaration.parameters.map((parameter) => publicParameter(checker, parameter, context)),
      publicReturnType(checker, declaration, declaration.type, context),
      undefined,
    );
  }
  if (ts.isVariableDeclaration(declaration)) {
    assertRepresentableAsyncInitializer(declaration);
    return ts.factory.updateVariableDeclaration(
      declaration,
      declaration.name,
      declaration.exclamationToken,
      publicType(checker, declaration, declaration.type, context),
      undefined,
    );
  }
  if (ts.isEnumDeclaration(declaration)) {
    return ts.factory.updateEnumDeclaration(
      declaration,
      publicModifiers(declaration.modifiers),
      declaration.name,
      declaration.members.map((member) => publicEnumMember(checker, member)),
    );
  }
  return ts.isClassDeclaration(declaration)
    ? ts.factory.updateClassDeclaration(
        declaration,
        publicModifiers(declaration.modifiers),
        declaration.name,
        declaration.typeParameters,
        declaration.heritageClauses,
        publicClassSyntaxElements(checker, declaration.members, context),
      )
    : ts.isModuleDeclaration(declaration)
      ? ts.factory.updateModuleDeclaration(
          declaration,
          publicModifiers(declaration.modifiers),
          declaration.name,
          publicModuleBody(checker, declaration.body, context),
        )
      : declaration;
}

function publicClassElement(
  checker: ts.TypeChecker,
  member: ts.ClassElement,
  context: PublicDeclarationProjectionContext,
): ts.ClassElement {
  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(
      member,
      publicModifiers(member.modifiers),
      hasPrivateModifier(member)
        ? []
        : member.parameters.map((parameter) =>
            publicConstructorParameter(checker, parameter, context),
          ),
      undefined,
    );
  }
  if (ts.isMethodDeclaration(member)) {
    assertRepresentableAsyncDeclaration(member);
    return ts.factory.updateMethodDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters.map((parameter) => publicParameter(checker, parameter, context)),
      publicReturnType(checker, member, member.type, context),
      undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.parameters.map((parameter) => publicParameter(checker, parameter, context)),
      publicReturnType(checker, member, member.type, context),
      undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.parameters.map((parameter) => publicParameter(checker, parameter, context)),
      undefined,
    );
  }
  if (ts.isPropertyDeclaration(member)) {
    assertRepresentableAsyncInitializer(member);
    return ts.factory.updatePropertyDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.questionToken ?? member.exclamationToken,
      publicType(checker, member, member.type, context),
      undefined,
    );
  }
  return member;
}

function publicModuleBody(
  checker: ts.TypeChecker,
  body: ts.ModuleBody | undefined,
  context: PublicDeclarationProjectionContext,
): ts.ModuleBody | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (ts.isModuleDeclaration(body)) {
    return publicDeclaration(checker, body, context) as ts.NamespaceDeclaration;
  }
  if (!ts.isModuleBlock(body)) {
    return body;
  }
  const exportedStatements = body.statements.filter(isExportedNamespaceStatement);
  const exportedFunctions = exportedStatements.filter(ts.isFunctionDeclaration);
  const publicFunctions = new Set(withoutOverloadImplementations(checker, exportedFunctions));
  const publicStatements = exportedStatements.filter(
    (statement) => !ts.isFunctionDeclaration(statement) || publicFunctions.has(statement),
  );
  return ts.factory.updateModuleBlock(
    body,
    publicStatements.flatMap((statement) => publicNamespaceStatement(checker, statement, context)),
  );
}

function publicNamespaceStatement(
  checker: ts.TypeChecker,
  statement: ts.Statement,
  context: PublicDeclarationProjectionContext,
): readonly ts.Statement[] {
  if (ts.isVariableStatement(statement)) {
    return [
      ts.factory.updateVariableStatement(
        statement,
        publicModifiers(statement.modifiers),
        ts.factory.updateVariableDeclarationList(
          statement.declarationList,
          statement.declarationList.declarations.map(
            (declaration) =>
              publicDeclaration(checker, declaration, context) as ts.VariableDeclaration,
          ),
        ),
      ),
    ];
  }
  if (NAMESPACE_DECLARATION_KINDS.has(statement.kind)) {
    return [
      publicDeclaration(
        checker,
        statement as unknown as ts.Declaration,
        context,
      ) as unknown as ts.Statement,
    ];
  }
  return [];
}

function isExportedNamespaceStatement(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement)) {
    return true;
  }
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
  );
}

function publicType(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  explicitType: ts.TypeNode | undefined,
  context: PublicDeclarationProjectionContext,
): ts.TypeNode {
  if (explicitType !== undefined) {
    return explicitType;
  }
  const inferredType = checker.getTypeAtLocation(declaration);
  assertNoImplementationLocalType(checker, inferredType, context);
  const typeNode = checker.typeToTypeNode(inferredType, declaration, INFERRED_TYPE_FLAGS);
  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(
      "A source-backed declaration type could not be represented statically.",
    );
  }
  assertReliableInferredType(typeNode, context);
  return typeNode;
}

function publicReturnType(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  explicitType: ts.TypeNode | undefined,
  context: PublicDeclarationProjectionContext,
): ts.TypeNode {
  if (explicitType !== undefined) {
    return explicitType;
  }
  const signature = checker.getSignatureFromDeclaration(declaration);
  const returnType =
    signature === undefined ? undefined : checker.getReturnTypeOfSignature(signature);
  if (returnType !== undefined) {
    assertNoImplementationLocalType(checker, returnType, context);
  }
  const typeNode =
    returnType === undefined
      ? undefined
      : checker.typeToTypeNode(returnType, declaration, INFERRED_TYPE_FLAGS);
  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(
      "A source-backed declaration return type could not be represented statically.",
    );
  }
  assertReliableInferredType(typeNode, context);
  return typeNode;
}

function assertReliableInferredType(
  typeNode: ts.TypeNode,
  context?: PublicDeclarationProjectionContext,
): void {
  const traversal = { nodeCount: 0 };
  const reserveTraversal =
    context?.reserveTraversal ??
    ((depth: number) => reserveInferredTypeSyntaxTraversal(traversal, depth));
  if (containsDegradedInferredType(typeNode, reserveTraversal, 0)) {
    throw new UnsupportedInspectionError(
      "An inferred Public Interface type cannot be represented statically without standard libraries.",
    );
  }
}

function containsDegradedInferredType(
  node: ts.Node,
  reserveTraversal: (depth: number) => void,
  depth: number,
): boolean {
  reserveTraversal(depth);
  if (
    node.kind === ts.SyntaxKind.AnyKeyword ||
    node.kind === ts.SyntaxKind.UnknownKeyword ||
    (ts.isTypeLiteralNode(node) && node.members.length === 0)
  ) {
    return true;
  }
  let degraded = false;
  ts.forEachChild(node, (child) => {
    degraded ||= containsDegradedInferredType(child, reserveTraversal, depth + 1);
  });
  return degraded;
}

function reserveInferredTypeSyntaxTraversal(traversal: { nodeCount: number }, depth: number): void {
  traversal.nodeCount += 1;
  if (
    depth > MAX_INFERRED_TYPE_TRAVERSAL_DEPTH ||
    traversal.nodeCount > MAX_INFERRED_TYPE_TRAVERSAL_NODES
  ) {
    throw new InspectionLimitError("Inspection exceeded its inferred type traversal limit.");
  }
}

function assertNoImplementationLocalType(
  checker: ts.TypeChecker,
  rootType: ts.Type,
  context?: PublicDeclarationProjectionContext,
): void {
  const pending: { readonly depth: number; readonly type: ts.Type }[] = [
    { depth: 0, type: rootType },
  ];
  const visited = context?.validatedTypes ?? new Set<ts.Type>();
  for (const { depth, type } of pending) {
    if (visited.has(type)) {
      continue;
    }
    visited.add(type);
    if (context === undefined) {
      if (visited.size > MAX_INFERRED_TYPE_TRAVERSAL_NODES) {
        throw new InspectionLimitError("Inspection exceeded its inferred type traversal limit.");
      }
    } else {
      context.reserveTypeTraversal(depth);
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (
      symbol?.declarations?.some((declaration) =>
        isImplementationLocalDeclaration(declaration, context?.reserveTypeTraversal),
      ) === true
    ) {
      throw new UnsupportedInspectionError(
        "An inferred Public Interface references an implementation-local type.",
      );
    }
    pending.push(
      ...inferredPublicTypeChildren(checker, type).map((childType) => ({
        depth: depth + 1,
        type: childType,
      })),
    );
  }
}

function isImplementationLocalDeclaration(
  declaration: ts.Declaration,
  reserveTraversal?: (depth: number) => void,
): boolean {
  let depth = 0;
  for (let ancestor = declaration.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    reserveTraversal?.(depth);
    depth += 1;
    if (ts.isSourceFile(ancestor) || ts.isModuleBlock(ancestor)) {
      return false;
    }
    if (ts.isBlock(ancestor)) {
      return true;
    }
  }
  return false;
}

/** Identifies declaration kinds that can be represented as named Supporting Types. */
export function isNamedTypeDeclarationSyntax(
  declaration: ts.Declaration,
): declaration is
  | ts.ClassDeclaration
  | ts.EnumDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration {
  return (
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  );
}

function hasNamedTypeSurface(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol?.declarations?.some(isNamedTypeDeclarationSyntax) === true;
}

function compositeTypeChildren(type: ts.Type): readonly ts.Type[] {
  return type.isUnionOrIntersection() ? type.types : [];
}

function genericTypeChildren(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  const children = [...(type.aliasTypeArguments ?? [])];
  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
  ) {
    children.push(...checker.getTypeArguments(type as ts.TypeReference));
  }
  return children;
}

function signatureTypeChildren(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  return [ts.SignatureKind.Call, ts.SignatureKind.Construct].flatMap((kind) =>
    checker
      .getSignaturesOfType(type, kind)
      .flatMap((signature) => [
        checker.getReturnTypeOfSignature(signature),
        ...signature.getParameters().flatMap((parameter) => symbolType(checker, parameter)),
      ]),
  );
}

function propertyTypeChildren(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  return type
    .getProperties()
    .filter(
      (property) =>
        property.declarations?.some((declaration) => isPrivateDeclaration(declaration)) !== true,
    )
    .flatMap((property) => symbolType(checker, property));
}

function symbolType(checker: ts.TypeChecker, symbol: ts.Symbol): readonly ts.Type[] {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration === undefined ? [] : [checker.getTypeOfSymbolAtLocation(symbol, declaration)];
}

function publicParameter(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  context: PublicDeclarationProjectionContext,
): ts.ParameterDeclaration {
  const type = publicType(checker, parameter, parameter.type, context);
  const hasRequiredFollowingParameter = hasRequiredParameterAfter(parameter);
  return ts.factory.updateParameterDeclaration(
    parameter,
    publicModifiers(parameter.modifiers),
    parameter.dotDotDotToken,
    parameter.name,
    parameter.questionToken ??
      (parameter.initializer === undefined || hasRequiredFollowingParameter
        ? undefined
        : ts.factory.createToken(ts.SyntaxKind.QuestionToken)),
    parameter.initializer !== undefined && hasRequiredFollowingParameter
      ? typeIncludingUndefined(type)
      : type,
    undefined,
  );
}

function publicConstructorParameter(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  context: PublicDeclarationProjectionContext,
): ts.ParameterDeclaration {
  const publicParameterDeclaration = publicParameter(checker, parameter, context);
  if (!hasPrivateModifier(parameter)) {
    return publicParameterDeclaration;
  }
  return ts.factory.updateParameterDeclaration(
    publicParameterDeclaration,
    publicParameterDeclaration.modifiers?.filter(({ kind }) => !isParameterPropertyModifier(kind)),
    publicParameterDeclaration.dotDotDotToken,
    publicParameterDeclaration.name,
    publicParameterDeclaration.questionToken,
    publicParameterDeclaration.type,
    undefined,
  );
}

function isParameterPropertyModifier(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
    ts.SyntaxKind.OverrideKeyword,
  ].includes(kind);
}

function isConstructorParameterProperty(node: ts.Node): node is ts.ParameterDeclaration {
  return ts.isParameter(node) && ts.isConstructorDeclaration(node.parent);
}

function hasPrivateIdentifier(node: ts.Node): boolean {
  const name = "name" in node ? (node.name as ts.Node | undefined) : undefined;
  return name === undefined ? false : ts.isPrivateIdentifier(name);
}

function hasPrivateModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword);
}

function publicClassMembers(
  checker: ts.TypeChecker,
  members: readonly ts.ClassElement[],
): readonly ts.ClassElement[] {
  const membersWithoutImplementations = withoutOverloadImplementations(
    checker,
    members.filter(
      (member) =>
        (!isPrivateDeclaration(member) || ts.isConstructorDeclaration(member)) &&
        !ts.isClassStaticBlockDeclaration(member),
    ),
  );
  let retainedPrivateConstructor = false;
  return membersWithoutImplementations.filter((member) => {
    if (!ts.isConstructorDeclaration(member) || !hasPrivateModifier(member)) {
      return true;
    }
    if (retainedPrivateConstructor) {
      return false;
    }
    retainedPrivateConstructor = true;
    return true;
  });
}

function publicClassSyntaxElements(
  checker: ts.TypeChecker,
  members: readonly ts.ClassElement[],
  context: PublicDeclarationProjectionContext,
): readonly ts.ClassElement[] {
  const retainedMembers = publicClassMembers(checker, members);
  const retainedMemberSet = new Set(retainedMembers);
  const parameterProperties = unrenderedConstructorParameterProperties(
    members,
    retainedMemberSet,
  ).map((parameter) => publicParameterProperty(checker, parameter, context));
  const projectedMembers = retainedMembers.map((member) =>
    publicClassElement(checker, member, context),
  );
  const constructorIndex = projectedMembers.findIndex(ts.isConstructorDeclaration);
  const propertyIndex = constructorIndex === -1 ? 0 : constructorIndex;
  return [
    ...projectedMembers.slice(0, propertyIndex),
    ...parameterProperties,
    ...projectedMembers.slice(propertyIndex),
  ];
}

function unrenderedConstructorParameterProperties(
  members: readonly ts.ClassElement[],
  retainedMembers: ReadonlySet<ts.ClassElement>,
): readonly IdentifiedParameter[] {
  return members.flatMap((member) =>
    ts.isConstructorDeclaration(member) &&
    (hasPrivateModifier(member) || !retainedMembers.has(member))
      ? visibleConstructorParameterProperties(member)
      : [],
  );
}

function visibleConstructorParameterProperties(
  constructor: ts.ConstructorDeclaration,
): readonly IdentifiedParameter[] {
  return constructor.parameters.filter(isVisibleConstructorParameterProperty);
}

type IdentifiedParameter = ts.ParameterDeclaration & { readonly name: ts.Identifier };

function isVisibleConstructorParameterProperty(
  parameter: ts.ParameterDeclaration,
): parameter is IdentifiedParameter {
  return (
    ts.isIdentifier(parameter.name) &&
    !hasPrivateModifier(parameter) &&
    (parameter.modifiers ?? []).some(({ kind }) => isParameterPropertyModifier(kind))
  );
}

function isDiscardedProjectionSyntax(child: ts.Node): boolean {
  return (
    ts.isModuleBlock(child) || ts.isClassStaticBlockDeclaration(child) || ts.isDecorator(child)
  );
}

function isUnprojectedConstructorChild(
  checker: ts.TypeChecker,
  parent: ts.Node,
  child: ts.Node,
): boolean {
  if (!ts.isConstructorDeclaration(parent) || !constructorProjectsOnlyProperties(checker, parent)) {
    return false;
  }
  return !ts.isParameter(child) || !isVisibleConstructorParameterProperty(child);
}

function constructorProjectsOnlyProperties(
  checker: ts.TypeChecker,
  constructor: ts.ConstructorDeclaration,
): boolean {
  if (hasPrivateModifier(constructor)) {
    return true;
  }
  const parent = constructor.parent;
  return (
    ts.isClassLike(parent) && !publicClassMembers(checker, parent.members).includes(constructor)
  );
}

function isNonPublicClassProjectionChild(
  checker: ts.TypeChecker,
  parent: ts.Node,
  child: ts.Node,
): boolean {
  if (!ts.isClassLike(parent)) {
    return false;
  }
  if (ts.isConstructorDeclaration(child)) {
    const retained = publicClassMembers(checker, parent.members).includes(child);
    return retained
      ? hasPrivateModifier(child) && visibleConstructorParameterProperties(child).length === 0
      : visibleConstructorParameterProperties(child).length === 0;
  }
  if (ts.isClassElement(child)) {
    return !publicClassMembers(checker, parent.members).includes(child);
  }
  return hasPrivateIdentifier(child) || hasPrivateModifier(child);
}

function isProjectionFunctionBody(parent: ts.Node, child: ts.Node): boolean {
  return ts.isFunctionLike(parent) && "body" in parent && parent.body === child;
}

function isProjectionInitializer(parent: ts.Node, child: ts.Node): boolean {
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
    parent.initializer === child
  );
}

function publicParameterProperty(
  checker: ts.TypeChecker,
  parameter: IdentifiedParameter,
  context: PublicDeclarationProjectionContext,
): ts.PropertyDeclaration {
  const modifiers = publicModifiers(parameter.modifiers)?.filter(
    ({ kind }) => kind !== ts.SyntaxKind.PublicKeyword,
  );
  return ts.factory.createPropertyDeclaration(
    modifiers,
    parameter.name,
    parameter.questionToken,
    publicType(checker, parameter, parameter.type, context),
    undefined,
  );
}

function withoutOverloadImplementations<T extends ts.Declaration>(
  checker: ts.TypeChecker,
  declarations: readonly T[],
): readonly T[] {
  return declarations.filter(
    (declaration) => !isOverloadImplementation(checker, declaration, declarations),
  );
}

function isOverloadImplementation(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  declarations: readonly ts.Declaration[],
): boolean {
  if (!hasFunctionBody(declaration)) {
    return false;
  }
  return declarations.some(
    (candidate) =>
      candidate !== declaration &&
      !hasFunctionBody(candidate) &&
      sameOverloadGroup(checker, declaration, candidate),
  );
}

function hasFunctionBody(
  declaration: ts.Declaration,
): declaration is ts.ConstructorDeclaration | ts.FunctionDeclaration | ts.MethodDeclaration {
  return (
    (ts.isConstructorDeclaration(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    declaration.body !== undefined
  );
}

function sameOverloadGroup(
  checker: ts.TypeChecker,
  left: ts.Declaration,
  right: ts.Declaration,
): boolean {
  const sameMethod = sameMethodOverloadGroup(checker, left, right);
  if (sameMethod !== undefined) {
    return sameMethod;
  }
  const leftGroup = overloadGroup(left);
  return leftGroup !== undefined && leftGroup === overloadGroup(right);
}

function sameMethodOverloadGroup(
  checker: ts.TypeChecker,
  left: ts.Declaration,
  right: ts.Declaration,
): boolean | undefined {
  if (!ts.isMethodDeclaration(left) || !ts.isMethodDeclaration(right)) {
    return undefined;
  }
  if (
    hasModifier(left, ts.SyntaxKind.StaticKeyword) !==
    hasModifier(right, ts.SyntaxKind.StaticKeyword)
  ) {
    return false;
  }
  const leftSymbol = checker.getSymbolAtLocation(left.name);
  const rightSymbol = checker.getSymbolAtLocation(right.name);
  if (leftSymbol !== undefined && leftSymbol === rightSymbol) {
    return true;
  }
  return ts.isComputedPropertyName(left.name) && ts.isComputedPropertyName(right.name)
    ? sameComputedPropertyType(checker, left.name.expression, right.name.expression) || undefined
    : undefined;
}

function sameComputedPropertyType(
  checker: ts.TypeChecker,
  left: ts.Expression,
  right: ts.Expression,
): boolean {
  const leftType = checker.getTypeAtLocation(left);
  const rightType = checker.getTypeAtLocation(right);
  if ((leftType.flags & ts.TypeFlags.UniqueESSymbol) !== 0) {
    return leftType === rightType || leftType.symbol === rightType.symbol;
  }
  if (leftType.isStringLiteral() && rightType.isStringLiteral()) {
    return leftType.value === rightType.value;
  }
  return leftType.isNumberLiteral() && rightType.isNumberLiteral()
    ? leftType.value === rightType.value
    : false;
}

function overloadGroup(declaration: ts.Declaration): string | undefined {
  if (ts.isConstructorDeclaration(declaration)) {
    return "constructor";
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return `function:${declaration.name?.getText() ?? "default"}`;
  }
  if (ts.isMethodDeclaration(declaration)) {
    const placement = hasModifier(declaration, ts.SyntaxKind.StaticKeyword) ? "static" : "instance";
    return `method:${placement}:${overloadPropertyName(declaration.name)}`;
  }
  return undefined;
}

function overloadPropertyName(name: ts.PropertyName): string {
  if (ts.isPrivateIdentifier(name)) {
    return `private:${name.text}`;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return `property:${name.text}`;
  }
  if (!ts.isComputedPropertyName(name)) {
    return `syntax:${name.getText()}`;
  }
  const expression = unwrapTransparentExpression(name.expression);
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
    ? `property:${expression.text}`
    : `computed:${overloadExpressionName(expression)}`;
}

function overloadExpressionName(expression: ts.Expression): string {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return `identifier:${value.text}`;
  }
  if (ts.isPropertyAccessExpression(value)) {
    return `access:${overloadExpressionName(value.expression)}:${value.name.text}`;
  }
  if (ts.isElementAccessExpression(value)) {
    const argument =
      value.argumentExpression === undefined
        ? undefined
        : unwrapTransparentExpression(value.argumentExpression);
    if (
      argument !== undefined &&
      (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ) {
      return `access:${overloadExpressionName(value.expression)}:${argument.text}`;
    }
  }
  return `syntax:${value.getText()}`;
}

function publicModifiers(
  modifiers: readonly ts.ModifierLike[] | undefined,
): readonly ts.ModifierLike[] | undefined {
  return modifiers?.filter(
    (modifier) => !ts.isDecorator(modifier) && modifier.kind !== ts.SyntaxKind.AsyncKeyword,
  );
}

function assertRepresentableAsyncDeclaration(
  declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
): void {
  if (
    declaration.type === undefined &&
    !declaration.getSourceFile().isDeclarationFile &&
    hasModifier(declaration, ts.SyntaxKind.AsyncKeyword)
  ) {
    throw new UnsupportedInspectionError(
      "An inferred async Public Interface cannot be represented statically.",
    );
  }
}

function assertRepresentableAsyncInitializer(
  declaration: ts.VariableDeclaration | ts.PropertyDeclaration,
): void {
  const initializer = declaration.initializer;
  if (
    declaration.type === undefined &&
    initializer !== undefined &&
    containsPublicAsyncValue(initializer)
  ) {
    throw new UnsupportedInspectionError(
      "An inferred async Public Interface cannot be represented statically.",
    );
  }
}

function containsPublicAsyncValue(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return hasModifier(value, ts.SyntaxKind.AsyncKeyword);
  }
  if (ts.isConditionalExpression(value)) {
    return containsPublicAsyncValue(value.whenTrue) || containsPublicAsyncValue(value.whenFalse);
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return false;
  }
  return value.properties.some((property) => {
    if (ts.isMethodDeclaration(property)) {
      return hasModifier(property, ts.SyntaxKind.AsyncKeyword);
    }
    return ts.isPropertyAssignment(property) && containsPublicAsyncValue(property.initializer);
  });
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === kind)
  );
}

function publicEnumMember(checker: ts.TypeChecker, member: ts.EnumMember): ts.EnumMember {
  if (member.getSourceFile().isDeclarationFile || member.initializer === undefined) {
    return member;
  }
  return ts.factory.updateEnumMember(member, member.name, constantExpression(checker, member));
}

function constantExpression(
  checker: ts.TypeChecker,
  member: ts.EnumMember,
): ts.Expression | undefined {
  const value = checker.getConstantValue(member);
  if (typeof value === "string") {
    return ts.factory.createStringLiteral(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 0 || Object.is(value, -0)
    ? ts.factory.createPrefixUnaryExpression(
        ts.SyntaxKind.MinusToken,
        ts.factory.createNumericLiteral(Math.abs(value)),
      )
    : ts.factory.createNumericLiteral(value);
}

function hasRequiredParameterAfter(parameter: ts.ParameterDeclaration): boolean {
  const parameters = parameterDeclarations(parameter.parent);
  const parameterIndex = parameters.indexOf(parameter);
  return parameters
    .slice(parameterIndex + 1)
    .some(
      (candidate) =>
        candidate.questionToken === undefined &&
        candidate.initializer === undefined &&
        candidate.dotDotDotToken === undefined,
    );
}

function typeIncludingUndefined(type: ts.TypeNode): ts.TypeNode {
  if (
    ts.isUnionTypeNode(type) &&
    type.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword)
  ) {
    return type;
  }
  return ts.factory.createUnionTypeNode([
    type,
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
  ]);
}

function collectInferredPublicTypes(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  types: ts.Type[],
): void {
  collectInferredDeclarationType(checker, declaration, types);
  collectInferredReturnType(checker, declaration, types);
  parameterDeclarations(declaration).forEach((parameter) =>
    collectInferredPublicTypes(checker, parameter, types),
  );
  inferredPublicClassDeclarations(checker, declaration).forEach((member) =>
    collectInferredPublicTypes(checker, member, types),
  );
}

function collectInferredDeclarationType(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  types: ts.Type[],
): void {
  if (
    explicitDeclarationType(declaration) === undefined &&
    INFERRED_DECLARATION_TYPE_KINDS.has(declaration.kind)
  ) {
    types.push(checker.getTypeAtLocation(declaration));
  }
}

function collectInferredReturnType(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  types: ts.Type[],
): void {
  if (
    explicitDeclarationType(declaration) !== undefined ||
    !INFERRED_RETURN_TYPE_KINDS.has(declaration.kind)
  ) {
    return;
  }
  const signature = checker.getSignatureFromDeclaration(declaration as ts.SignatureDeclaration);
  if (signature !== undefined) {
    types.push(checker.getReturnTypeOfSignature(signature));
  }
}

function explicitDeclarationType(declaration: ts.Declaration): ts.TypeNode | undefined {
  return "type" in declaration ? (declaration.type as ts.TypeNode | undefined) : undefined;
}

function inferredPublicClassDeclarations(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): readonly ts.Declaration[] {
  if (!ts.isClassDeclaration(declaration)) {
    return [];
  }
  const retainedMembers = publicClassMembers(checker, declaration.members);
  const visibleParameterProperties = unrenderedConstructorParameterProperties(
    declaration.members,
    new Set(retainedMembers),
  );
  const visibleMembers = retainedMembers.filter((member) => !isPrivateDeclaration(member));
  return [...visibleParameterProperties, ...visibleMembers];
}

function parameterDeclarations(node: ts.Node): readonly ts.ParameterDeclaration[] {
  if (
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.parameters;
  }
  return [];
}
