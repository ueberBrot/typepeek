import ts from "@typescript/typescript6";

import { InspectionLimitError } from "#typepeek/inspection/errors";
import {
  type FocusedExportResolution,
  resolveFocusedExport,
} from "#typepeek/inspection/focused-export";
import type { InspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import type {
  ExportSignature,
  InspectedSignature,
  SignatureInspection,
  SignatureBinding,
  SignatureParameter,
  SignatureReturn,
  SignatureTypeParameter,
  SignatureTypeParameterModifier,
} from "#typepeek/inspection/protocol";
import { SignatureInspectionConstruction } from "#typepeek/inspection/result-construction";

const MAX_SIGNATURES = 64;
const MAX_SIGNATURE_BYTES = 16 * 1_024;
const MAX_SIGNATURE_TOTAL_BYTES = 48 * 1_024;
const MAX_SIGNATURE_PARAMETERS = 256;
const MAX_SIGNATURE_TYPE_PARAMETERS = 64;
const SIGNATURE_TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.NoTypeReduction |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

interface SignatureCandidate {
  readonly compilerOrder: number;
  readonly kind: ExportSignature["kind"];
  readonly signature: ts.Signature;
  readonly signatureKind: ts.SignatureKind;
}

type RetainSignature<Value> = (value: Value) => Value;

interface SignatureProjection<Value> {
  readonly project: (candidate: SignatureCandidate) => Value;
  readonly retain: RetainSignature<Value>;
  readonly serializeForBudget: (value: Value) => string;
}

/** Produces a focused result without declaration or Supporting Type traversal. */
export function inspectModuleExportSignatures(
  evidence: InspectableModuleEvidence,
  exportName: string,
  specifier: string,
): SignatureInspection | undefined {
  const resolution = resolveFocusedExport(evidence.checker, evidence.moduleSymbol, exportName);
  if (resolution === undefined) {
    return undefined;
  }

  const construction = new SignatureInspectionConstruction();
  const signatures = inspectResolvedExportSignatureDetails(evidence.checker, resolution, (value) =>
    construction.signature(value),
  );
  const moduleExport = construction.moduleExport(
    resolution.exportedSymbol.getName(),
    resolution.aliasTargetName,
    signatures,
  );
  return construction.result(specifier, evidence.resultIdentity, moduleExport);
}

export function inspectResolvedExportSignatures(
  checker: ts.TypeChecker,
  resolution: FocusedExportResolution,
  retainSignature: (value: ExportSignature) => ExportSignature,
): readonly ExportSignature[] {
  return inspectBoundedSignatures(checker, resolution, {
    project: ({ kind, signature, signatureKind }) => ({
      kind,
      text: checker.signatureToString(
        signature,
        signature.getDeclaration(),
        SIGNATURE_TYPE_FORMAT_FLAGS,
        signatureKind,
      ),
    }),
    retain: retainSignature,
    serializeForBudget: ({ text }) => text,
  });
}

function inspectResolvedExportSignatureDetails(
  checker: ts.TypeChecker,
  resolution: FocusedExportResolution,
  retainSignature: RetainSignature<InspectedSignature>,
): readonly InspectedSignature[] {
  return inspectBoundedSignatures(checker, resolution, {
    project: ({ kind, signature, signatureKind }) =>
      inspectSignatureDetails(checker, kind, signature, signatureKind),
    retain: retainSignature,
    serializeForBudget: (signature) => JSON.stringify(signature),
  });
}

function inspectBoundedSignatures<Value>(
  checker: ts.TypeChecker,
  resolution: FocusedExportResolution,
  projection: SignatureProjection<Value>,
): readonly Value[] {
  let totalBytes = 0;
  return orderedSignatureCandidates(checker, resolution).map((candidate) => {
    const inspectedSignature = projection.project(candidate);
    const signatureBytes = Buffer.byteLength(projection.serializeForBudget(inspectedSignature));
    totalBytes += signatureBytes;
    if (signatureBytes > MAX_SIGNATURE_BYTES || totalBytes > MAX_SIGNATURE_TOTAL_BYTES) {
      throw new InspectionLimitError("Inspection exceeded its Module Export signature byte limit.");
    }
    return projection.retain(inspectedSignature);
  });
}

function orderedSignatureCandidates(
  checker: ts.TypeChecker,
  resolution: FocusedExportResolution,
): SignatureCandidate[] {
  const symbol = resolution.targetSymbol;
  const declaration = signatureDeclaration(symbol);
  if (declaration === undefined) {
    return [];
  }
  const type = signatureType(checker, symbol, declaration, resolution.valueAccessible);
  const candidates = [
    ...signatureCandidates(checker, type, ts.SignatureKind.Call, "call"),
    ...signatureCandidates(checker, type, ts.SignatureKind.Construct, "construct"),
  ];
  const sourceOrder = declarationSourceOrder(symbol, type);
  candidates.sort((left, right) => compareSignatureCandidates(left, right, sourceOrder));
  if (candidates.length > MAX_SIGNATURES) {
    throw new InspectionLimitError("Inspection exceeded its Module Export signature limit.");
  }
  return candidates;
}

function inspectSignatureDetails(
  checker: ts.TypeChecker,
  kind: InspectedSignature["kind"],
  signature: ts.Signature,
  signatureKind: ts.SignatureKind,
): InspectedSignature {
  const declaration = signature.getDeclaration();
  const parameters = signature.getParameters();
  const typeParameters = signature.getTypeParameters() ?? [];
  if (parameters.length > MAX_SIGNATURE_PARAMETERS) {
    throw new InspectionLimitError("Inspection exceeded its signature parameter limit.");
  }
  if (typeParameters.length > MAX_SIGNATURE_TYPE_PARAMETERS) {
    throw new InspectionLimitError("Inspection exceeded its signature type parameter limit.");
  }
  return {
    kind,
    text: checker.signatureToString(
      signature,
      declaration,
      SIGNATURE_TYPE_FORMAT_FLAGS,
      signatureKind,
    ),
    typeParameters: typeParameters.map((item) =>
      inspectSignatureTypeParameter(checker, item, declaration),
    ),
    ...(signature.thisParameter === undefined
      ? {}
      : {
          thisParameter: {
            type: renderSymbolType(checker, signature.thisParameter, declaration),
          },
        }),
    parameters: parameters.map((item) => inspectSignatureParameter(checker, item, declaration)),
    returns: inspectSignatureReturn(checker, signature, declaration),
  };
}

function inspectSignatureParameter(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  enclosingDeclaration: ts.SignatureDeclaration,
): SignatureParameter {
  const declaration = findParameterDeclaration(symbol);
  const location = declaration ?? enclosingDeclaration;
  const parameterType = checker.getTypeOfSymbolAtLocation(symbol, location);
  const rest = declaration?.dotDotDotToken !== undefined;
  return {
    binding: inspectSignatureBinding(symbol, declaration),
    type: renderSignatureType(checker, parameterType, location),
    optional: rest
      ? restParameterMayBeOmitted(checker, parameterType)
      : declaration === undefined
        ? (symbol.flags & ts.SymbolFlags.Optional) !== 0
        : checker.isOptionalParameter(declaration),
    rest,
  };
}

function restParameterMayBeOmitted(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.some((item) => restParameterMayBeOmitted(checker, item));
  }
  return !checker.isTupleType(type) || (type as ts.TupleTypeReference).target.minLength === 0;
}

function inspectSignatureBinding(
  symbol: ts.Symbol,
  declaration: ts.ParameterDeclaration | undefined,
): SignatureBinding {
  if (declaration === undefined) {
    return { kind: "identifier", name: symbol.getName(), synthetic: true };
  }
  return ts.isIdentifier(declaration.name)
    ? { kind: "identifier", name: declaration.name.text, synthetic: false }
    : { kind: "pattern", text: declaration.name.getText(declaration.getSourceFile()) };
}

function findParameterDeclaration(symbol: ts.Symbol): ts.ParameterDeclaration | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.find(ts.isParameter);
  return declaration !== undefined && ts.isParameter(declaration) ? declaration : undefined;
}

function renderSymbolType(checker: ts.TypeChecker, symbol: ts.Symbol, location: ts.Node): string {
  return renderSignatureType(
    checker,
    checker.getTypeOfSymbolAtLocation(symbol, location),
    location,
  );
}

function inspectSignatureTypeParameter(
  checker: ts.TypeChecker,
  typeParameter: ts.TypeParameter,
  enclosingDeclaration: ts.SignatureDeclaration,
): SignatureTypeParameter {
  const declaration = typeParameter.symbol?.declarations?.find(ts.isTypeParameterDeclaration);
  const location = declaration ?? enclosingDeclaration;
  return {
    name: signatureTypeParameterName(checker, typeParameter, declaration, location),
    modifiers: inspectTypeParameterModifiers(declaration),
    ...signatureTypeParameterConstraint(checker, typeParameter, declaration, location),
    ...signatureTypeParameterDefault(checker, typeParameter, location),
    synthetic: declaration === undefined,
  };
}

function signatureTypeParameterName(
  checker: ts.TypeChecker,
  typeParameter: ts.TypeParameter,
  declaration: ts.TypeParameterDeclaration | undefined,
  location: ts.Node,
): string {
  return (
    declaration?.name.text ??
    typeParameter.symbol?.getName() ??
    renderSignatureType(checker, typeParameter, location)
  );
}

function signatureTypeParameterConstraint(
  checker: ts.TypeChecker,
  typeParameter: ts.TypeParameter,
  declaration: ts.TypeParameterDeclaration | undefined,
  location: ts.Node,
): Partial<Pick<SignatureTypeParameter, "constraint">> {
  if (declaration?.constraint !== undefined) {
    return { constraint: declaration.constraint.getText(declaration.getSourceFile()) };
  }
  if (declaration !== undefined) {
    return {};
  }
  const constraint = checker.getBaseConstraintOfType(typeParameter);
  return constraint === undefined
    ? {}
    : { constraint: renderSignatureType(checker, constraint, location) };
}

function signatureTypeParameterDefault(
  checker: ts.TypeChecker,
  typeParameter: ts.TypeParameter,
  location: ts.Node,
): Partial<Pick<SignatureTypeParameter, "default">> {
  const defaultType =
    typeParameter.getDefault() ?? checker.getDefaultFromTypeParameter(typeParameter);
  return defaultType === undefined
    ? {}
    : { default: renderSignatureType(checker, defaultType, location) };
}

function inspectTypeParameterModifiers(
  declaration: ts.TypeParameterDeclaration | undefined,
): readonly SignatureTypeParameterModifier[] {
  return (declaration?.modifiers ?? []).flatMap((modifier) => {
    switch (modifier.kind) {
      case ts.SyntaxKind.ConstKeyword:
        return ["const"];
      case ts.SyntaxKind.InKeyword:
        return ["in"];
      case ts.SyntaxKind.OutKeyword:
        return ["out"];
      default:
        return [];
    }
  });
}

function inspectSignatureReturn(
  checker: ts.TypeChecker,
  signature: ts.Signature,
  declaration: ts.SignatureDeclaration,
): SignatureReturn {
  const predicate = checker.getTypePredicateOfSignature(signature);
  if (predicate === undefined) {
    return {
      kind: "type",
      type: renderSignatureType(checker, checker.getReturnTypeOfSignature(signature), declaration),
    };
  }
  const parameter =
    predicate.kind === ts.TypePredicateKind.This ||
    predicate.kind === ts.TypePredicateKind.AssertsThis
      ? "this"
      : predicate.parameterName;
  if (
    predicate.kind === ts.TypePredicateKind.AssertsThis ||
    predicate.kind === ts.TypePredicateKind.AssertsIdentifier
  ) {
    return {
      kind: "assertion",
      parameter,
      ...(predicate.type === undefined
        ? {}
        : { type: renderSignatureType(checker, predicate.type, declaration) }),
    };
  }
  return {
    kind: "predicate",
    parameter,
    type: renderSignatureType(checker, predicate.type, declaration),
  };
}

function renderSignatureType(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string {
  return checker.typeToString(type, location, SIGNATURE_TYPE_FORMAT_FLAGS);
}

function signatureDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function signatureType(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  valueAccessible: boolean,
): ts.Type {
  return valueAccessible
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : checker.getDeclaredTypeOfSymbol(symbol);
}

function signatureCandidates(
  checker: ts.TypeChecker,
  type: ts.Type,
  signatureKind: ts.SignatureKind,
  kind: ExportSignature["kind"],
): readonly SignatureCandidate[] {
  return checker
    .getSignaturesOfType(type, signatureKind)
    .filter(
      (signature) =>
        signatureKind !== ts.SignatureKind.Construct || isPublicConstructorSignature(signature),
    )
    .map((signature, compilerOrder) => ({
      compilerOrder,
      kind,
      signature,
      signatureKind,
    }));
}

function isPublicConstructorSignature(signature: ts.Signature): boolean {
  const declaration = signature.getDeclaration();
  if (declaration === undefined) {
    return true;
  }
  if (abstractConstructorDeclaration(declaration)) {
    return false;
  }
  if (!ts.isConstructorDeclaration(declaration)) {
    return true;
  }
  return !hasAnyModifier(declaration, [
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
  ]);
}

function abstractConstructorDeclaration(declaration: ts.SignatureDeclaration): boolean {
  if (ts.isConstructorTypeNode(declaration)) {
    return hasAnyModifier(declaration, [ts.SyntaxKind.AbstractKeyword]);
  }
  if (ts.isConstructorDeclaration(declaration)) {
    return hasAnyModifier(declaration.parent, [ts.SyntaxKind.AbstractKeyword]);
  }
  return ts.isClassDeclaration(declaration)
    ? hasAnyModifier(declaration, [ts.SyntaxKind.AbstractKeyword])
    : false;
}

function hasAnyModifier(node: ts.Node, kinds: readonly ts.SyntaxKind[]): boolean {
  return (
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(({ kind }) =>
      kinds.includes(kind),
    ) ?? false
  );
}

function declarationSourceOrder(symbol: ts.Symbol, type: ts.Type): ReadonlyMap<string, number> {
  // TypeScript preserves order within one source file but can interleave
  // signatures from merged declarations. Rank their source files explicitly.
  const declarations = [...symbolDeclarations(symbol), ...symbolDeclarations(type.symbol)];
  const sources = declarations.map((declaration) => declaration.getSourceFile().fileName);
  return new Map(Array.from(new Set(sources), (source, index) => [source, index]));
}

function symbolDeclarations(symbol: ts.Symbol | undefined): readonly ts.Declaration[] {
  return symbol?.declarations ?? [];
}

function compareSignatureCandidates(
  left: SignatureCandidate,
  right: SignatureCandidate,
  sourceOrder: ReadonlyMap<string, number>,
): number {
  const leftDeclaration = left.signature.getDeclaration();
  const rightDeclaration = right.signature.getDeclaration();
  const sameSourceOrder = comparePositionsInSameSource(leftDeclaration, rightDeclaration);
  if (sameSourceOrder !== undefined) {
    return sameSourceOrder;
  }
  const sourceDifference =
    sourceRank(sourceOrder, leftDeclaration) - sourceRank(sourceOrder, rightDeclaration);
  return sourceDifference === 0 ? left.compilerOrder - right.compilerOrder : sourceDifference;
}

function comparePositionsInSameSource(
  left: ts.SignatureDeclaration,
  right: ts.SignatureDeclaration,
): number | undefined {
  return left.getSourceFile() === right.getSourceFile()
    ? left.getStart() - right.getStart()
    : undefined;
}

function sourceRank(
  sourceOrder: ReadonlyMap<string, number>,
  declaration: ts.SignatureDeclaration,
): number {
  return sourceOrder.get(declaration.getSourceFile().fileName) ?? Number.MAX_SAFE_INTEGER;
}
