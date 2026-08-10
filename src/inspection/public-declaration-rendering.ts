import ts from "@typescript/typescript6";

import { UnsupportedInspectionError } from "#typepeek/inspection/errors";

const INFERRED_TYPE_FLAGS = ts.NodeBuilderFlags.NoTruncation;
const declarationPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

/** Renders declaration or source evidence without executable implementation details. */
export function renderPublicDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): string {
  const sourceFile = declaration.getSourceFile();
  return declarationPrinter
    .printNode(ts.EmitHint.Unspecified, publicDeclarationSyntax(checker, declaration), sourceFile)
    .trim()
    .replace(/^(?:export\s+)?(?:declare\s+)?/u, "");
}

/** Projects source syntax onto the declaration-only Public Interface surface. */
export function publicDeclarationSyntax(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): ts.Declaration {
  const printableDeclaration = ts.isNamespaceExport(declaration) ? declaration.parent : declaration;
  return publicDeclaration(checker, printableDeclaration);
}

/** Identifies declaration nodes that cannot contribute to a Public Interface. */
export function isPrivateDeclaration(node: ts.Node): boolean {
  return (
    hasPrivateIdentifier(node) ||
    (hasPrivateModifier(node) && !isConstructorParameterProperty(node))
  );
}

/** Removes source overload implementations from the declarations visible to callers. */
export function publicDeclarations(
  declarations: readonly ts.Declaration[],
): readonly ts.Declaration[] {
  return withoutOverloadImplementations(declarations);
}

/** Returns checker types synthesized into a source-backed Public Interface. */
export function inferredPublicTypes(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): readonly ts.Type[] {
  const types: ts.Type[] = [];
  collectInferredPublicTypes(checker, declaration, types);
  return types;
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

function publicDeclaration(checker: ts.TypeChecker, declaration: ts.Declaration): ts.Declaration {
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
      declaration.parameters.map((parameter) => publicParameter(checker, parameter)),
      publicReturnType(checker, declaration, declaration.type),
      undefined,
    );
  }
  if (ts.isVariableDeclaration(declaration)) {
    assertRepresentableAsyncInitializer(declaration);
    return ts.factory.updateVariableDeclaration(
      declaration,
      declaration.name,
      declaration.exclamationToken,
      publicType(checker, declaration, declaration.type),
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
        publicClassMembers(declaration.members).map((member) =>
          publicClassElement(checker, member),
        ),
      )
    : ts.isModuleDeclaration(declaration)
      ? ts.factory.updateModuleDeclaration(
          declaration,
          publicModifiers(declaration.modifiers),
          declaration.name,
          publicModuleBody(checker, declaration.body),
        )
      : declaration;
}

function publicClassElement(checker: ts.TypeChecker, member: ts.ClassElement): ts.ClassElement {
  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.parameters.map((parameter) => publicConstructorParameter(checker, parameter)),
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
      member.parameters.map((parameter) => publicParameter(checker, parameter)),
      publicReturnType(checker, member, member.type),
      undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.parameters.map((parameter) => publicParameter(checker, parameter)),
      publicReturnType(checker, member, member.type),
      undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      publicModifiers(member.modifiers),
      member.name,
      member.parameters.map((parameter) => publicParameter(checker, parameter)),
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
      publicType(checker, member, member.type),
      undefined,
    );
  }
  return member;
}

function publicModuleBody(
  checker: ts.TypeChecker,
  body: ts.ModuleBody | undefined,
): ts.ModuleBody | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (ts.isModuleDeclaration(body)) {
    return publicDeclaration(checker, body) as ts.NamespaceDeclaration;
  }
  if (!ts.isModuleBlock(body)) {
    return body;
  }
  const exportedStatements = body.statements.filter(isExportedNamespaceStatement);
  const exportedFunctions = exportedStatements.filter(ts.isFunctionDeclaration);
  const publicFunctions = new Set(withoutOverloadImplementations(exportedFunctions));
  const publicStatements = exportedStatements.filter(
    (statement) => !ts.isFunctionDeclaration(statement) || publicFunctions.has(statement),
  );
  return ts.factory.updateModuleBlock(
    body,
    publicStatements.flatMap((statement) => publicNamespaceStatement(checker, statement)),
  );
}

function publicNamespaceStatement(
  checker: ts.TypeChecker,
  statement: ts.Statement,
): readonly ts.Statement[] {
  if (!isExportedNamespaceStatement(statement)) {
    return [];
  }
  if (ts.isVariableStatement(statement)) {
    return [
      ts.factory.updateVariableStatement(
        statement,
        publicModifiers(statement.modifiers),
        ts.factory.updateVariableDeclarationList(
          statement.declarationList,
          statement.declarationList.declarations.map(
            (declaration) => publicDeclaration(checker, declaration) as ts.VariableDeclaration,
          ),
        ),
      ),
    ];
  }
  if (
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isModuleDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  ) {
    return [publicDeclaration(checker, statement) as unknown as ts.Statement];
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
): ts.TypeNode {
  if (explicitType !== undefined) {
    return explicitType;
  }
  const inferredType = checker.getTypeAtLocation(declaration);
  assertNoImplementationLocalType(checker, inferredType);
  const typeNode = checker.typeToTypeNode(inferredType, declaration, INFERRED_TYPE_FLAGS);
  if (typeNode === undefined) {
    throw new UnsupportedInspectionError(
      "A source-backed declaration type could not be represented statically.",
    );
  }
  assertReliableInferredType(typeNode);
  return typeNode;
}

function publicReturnType(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  explicitType: ts.TypeNode | undefined,
): ts.TypeNode {
  if (explicitType !== undefined) {
    return explicitType;
  }
  const signature = checker.getSignatureFromDeclaration(declaration);
  const returnType =
    signature === undefined ? undefined : checker.getReturnTypeOfSignature(signature);
  if (returnType !== undefined) {
    assertNoImplementationLocalType(checker, returnType);
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
  assertReliableInferredType(typeNode);
  return typeNode;
}

function assertReliableInferredType(typeNode: ts.TypeNode): void {
  if (containsDegradedInferredType(typeNode)) {
    throw new UnsupportedInspectionError(
      "An inferred Public Interface type cannot be represented statically without standard libraries.",
    );
  }
}

function containsDegradedInferredType(node: ts.Node): boolean {
  if (
    node.kind === ts.SyntaxKind.AnyKeyword ||
    node.kind === ts.SyntaxKind.UnknownKeyword ||
    (ts.isTypeLiteralNode(node) && node.members.length === 0)
  ) {
    return true;
  }
  let degraded = false;
  ts.forEachChild(node, (child) => {
    degraded ||= containsDegradedInferredType(child);
  });
  return degraded;
}

function assertNoImplementationLocalType(checker: ts.TypeChecker, rootType: ts.Type): void {
  const pending = [rootType];
  const visited = new Set<ts.Type>();
  for (const type of pending) {
    if (visited.has(type)) {
      continue;
    }
    visited.add(type);
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol?.declarations?.some(isImplementationLocalDeclaration) === true) {
      throw new UnsupportedInspectionError(
        "An inferred Public Interface references an implementation-local type.",
      );
    }
    pending.push(...inferredPublicTypeChildren(checker, type));
  }
}

function isImplementationLocalDeclaration(declaration: ts.Declaration): boolean {
  for (let ancestor = declaration.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    if (ts.isSourceFile(ancestor) || ts.isModuleBlock(ancestor)) {
      return false;
    }
    if (ts.isBlock(ancestor)) {
      return true;
    }
  }
  return false;
}

function hasNamedTypeSurface(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol?.declarations?.some(isNamedTypeDeclarationSyntax) === true;
}

function isNamedTypeDeclarationSyntax(declaration: ts.Declaration): boolean {
  return (
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  );
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
): ts.ParameterDeclaration {
  const type = publicType(checker, parameter, parameter.type);
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
): ts.ParameterDeclaration {
  const publicParameterDeclaration = publicParameter(checker, parameter);
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

function publicClassMembers(members: readonly ts.ClassElement[]): readonly ts.ClassElement[] {
  return withoutOverloadImplementations(
    members.filter(
      (member) => !isPrivateDeclaration(member) && !ts.isClassStaticBlockDeclaration(member),
    ),
  );
}

function withoutOverloadImplementations<T extends ts.Declaration>(
  declarations: readonly T[],
): readonly T[] {
  return declarations.filter((declaration) => !isOverloadImplementation(declaration, declarations));
}

function isOverloadImplementation(
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
      sameOverloadGroup(declaration, candidate),
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

function sameOverloadGroup(left: ts.Declaration, right: ts.Declaration): boolean {
  if (ts.isConstructorDeclaration(left) || ts.isConstructorDeclaration(right)) {
    return ts.isConstructorDeclaration(left) && ts.isConstructorDeclaration(right);
  }
  if (ts.isFunctionDeclaration(left) || ts.isFunctionDeclaration(right)) {
    return (
      ts.isFunctionDeclaration(left) &&
      ts.isFunctionDeclaration(right) &&
      left.name?.getText() === right.name?.getText()
    );
  }
  return (
    ts.isMethodDeclaration(left) &&
    ts.isMethodDeclaration(right) &&
    left.name.getText() === right.name.getText() &&
    hasModifier(left, ts.SyntaxKind.StaticKeyword) ===
      hasModifier(right, ts.SyntaxKind.StaticKeyword)
  );
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
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isParameter(declaration)) &&
    declaration.type === undefined
  ) {
    types.push(checker.getTypeAtLocation(declaration));
  }
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isGetAccessorDeclaration(declaration)) &&
    declaration.type === undefined
  ) {
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (signature !== undefined) {
      types.push(checker.getReturnTypeOfSignature(signature));
    }
  }
  for (const parameter of parameterDeclarations(declaration)) {
    collectInferredPublicTypes(checker, parameter, types);
  }
  if (ts.isClassDeclaration(declaration)) {
    for (const member of publicClassMembers(declaration.members)) {
      collectInferredPublicTypes(checker, member, types);
    }
  }
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
