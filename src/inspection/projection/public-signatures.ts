import {
  isClassDeclaration,
  isConstructorDeclaration,
  isConstructorTypeNode,
  SyntaxKind,
} from "tsrs/ast";
import type { Declaration, Node } from "tsrs/ast";
import { SignatureKind } from "tsrs/sync";
import type {
  Checker,
  Signature,
  Symbol as CompilerSymbol,
  Type,
} from "tsrs/sync";

import {
  declarationsOf,
  valueDeclarationOf,
  signatureText,
} from "#typepeek/inspection/compiler/compiler-session";
import { modifiersOf } from "#typepeek/inspection/compiler/compiler-syntax";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import type {
  ExportSignature,
  InspectedSignature,
} from "#typepeek/inspection/model/protocol";
import { inspectSignatureDetails } from "#typepeek/inspection/projection/signature-details";
import type { FocusedExportResolution } from "#typepeek/inspection/queries/focused-export";

const MAX_SIGNATURES = 64;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_SIGNATURE_TOTAL_BYTES = 48 * 1024;

interface SignatureCandidate {
  readonly compilerOrder: number;
  readonly kind: ExportSignature["kind"];
  readonly signature: Signature;
  readonly signatureKind: SignatureKind;
}

interface SignatureProjection<Value> {
  readonly project: (candidate: SignatureCandidate) => Value;
  readonly retain: (value: Value) => Value;
  readonly serializeForBudget: (value: Value) => string;
}

const signatureDeclaration = function signatureDeclaration(
  symbol: CompilerSymbol
): Declaration | undefined {
  return valueDeclarationOf(symbol) ?? declarationsOf(symbol)[0];
};

const signatureType = function signatureType(
  checker: Checker,
  symbol: CompilerSymbol,
  declaration: Declaration,
  valueAccessible: boolean
): Type {
  return valueAccessible
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : checker.getDeclaredTypeOfSymbol(symbol);
};

const hasAnyModifier = function hasAnyModifier(
  node: Node,
  kinds: readonly SyntaxKind[]
): boolean {
  return (
    (modifiersOf(node) === undefined ? undefined : modifiersOf(node))?.some(
      ({ kind }) => kinds.includes(kind)
    ) ?? false
  );
};

const abstractConstructorDeclaration = function abstractConstructorDeclaration(
  declaration: Node
): boolean {
  if (isConstructorTypeNode(declaration)) {
    return hasAnyModifier(declaration, [SyntaxKind.AbstractKeyword]);
  }

  if (isConstructorDeclaration(declaration)) {
    return hasAnyModifier(declaration.parent, [SyntaxKind.AbstractKeyword]);
  }

  return isClassDeclaration(declaration)
    ? hasAnyModifier(declaration, [SyntaxKind.AbstractKeyword])
    : false;
};

const isPublicConstructorSignature = function isPublicConstructorSignature(
  signature: Signature
): boolean {
  const declaration = signature.declaration?.resolve();

  if (declaration === undefined) {
    return true;
  }

  if (abstractConstructorDeclaration(declaration)) {
    return false;
  }

  if (!isConstructorDeclaration(declaration)) {
    return true;
  }

  return !hasAnyModifier(declaration, [
    SyntaxKind.PrivateKeyword,
    SyntaxKind.ProtectedKeyword,
  ]);
};

const appendSignatureCandidates = function appendSignatureCandidates(
  candidates: SignatureCandidate[],
  checker: Checker,
  type: Type,
  signatureKind: SignatureKind,
  kind: ExportSignature["kind"]
): void {
  const signatures = checker.getSignaturesOfType(type, signatureKind);

  for (const [compilerOrder, signature] of signatures.entries()) {
    if (
      signatureKind === SignatureKind.Construct &&
      !isPublicConstructorSignature(signature)
    ) {
      continue;
    }

    if (candidates.length >= MAX_SIGNATURES) {
      throw new InspectionLimitError(
        "signatures",
        "Inspection exceeded its Module Export signature limit."
      );
    }

    candidates.push({
      compilerOrder,
      kind,
      signature,
      signatureKind,
    });
  }
};

const symbolDeclarations = function symbolDeclarations(
  symbol: CompilerSymbol | undefined
): readonly Declaration[] {
  return declarationsOf(symbol) ?? [];
};

const declarationSourceOrder = function declarationSourceOrder(
  symbol: CompilerSymbol,
  type: Type
): ReadonlyMap<string, number> {
  // TypeScript preserves order within one source file but can interleave
  // signatures from merged declarations. Rank their source files explicitly.
  const declarations = [
    ...symbolDeclarations(symbol),
    ...symbolDeclarations(type.getSymbol()),
  ];

  const sources = declarations.map(
    (declaration) => declaration.getSourceFile().fileName
  );

  return new Map(
    Array.from(new Set(sources), (source, index) => [source, index])
  );
};

const comparePositionsInSameSource = function comparePositionsInSameSource(
  left: Node,
  right: Node
): number | undefined {
  return left.getSourceFile() === right.getSourceFile()
    ? left.getStart() - right.getStart()
    : undefined;
};

const sourceRank = function sourceRank(
  sourceOrder: ReadonlyMap<string, number>,
  declaration: Node
): number {
  return (
    sourceOrder.get(declaration.getSourceFile().fileName) ??
    Number.MAX_SAFE_INTEGER
  );
};

const compareSignatureCandidates = function compareSignatureCandidates(
  left: SignatureCandidate,
  right: SignatureCandidate,
  sourceOrder: ReadonlyMap<string, number>
): number {
  const leftDeclaration = left.signature.declaration?.resolve();
  const rightDeclaration = right.signature.declaration?.resolve();

  if (leftDeclaration === undefined || rightDeclaration === undefined) {
    return left.compilerOrder - right.compilerOrder;
  }

  const sameSourceOrder = comparePositionsInSameSource(
    leftDeclaration,
    rightDeclaration
  );

  if (sameSourceOrder !== undefined) {
    return sameSourceOrder;
  }

  const sourceDifference =
    sourceRank(sourceOrder, leftDeclaration) -
    sourceRank(sourceOrder, rightDeclaration);

  return sourceDifference === 0
    ? left.compilerOrder - right.compilerOrder
    : sourceDifference;
};

const orderedSignatureCandidates = function orderedSignatureCandidates(
  checker: Checker,
  resolution: FocusedExportResolution
): SignatureCandidate[] {
  const symbol = resolution.targetSymbol;
  const declaration = signatureDeclaration(symbol);

  if (declaration === undefined) {
    return [];
  }

  const type = signatureType(
    checker,
    symbol,
    declaration,
    resolution.valueAccessible
  );

  const candidates: SignatureCandidate[] = [];
  appendSignatureCandidates(
    candidates,
    checker,
    type,
    SignatureKind.Call,
    "call"
  );
  appendSignatureCandidates(
    candidates,
    checker,
    type,
    SignatureKind.Construct,
    "construct"
  );
  const sourceOrder = declarationSourceOrder(symbol, type);
  candidates.sort((left, right) =>
    compareSignatureCandidates(left, right, sourceOrder)
  );

  return candidates;
};

const inspectBoundedSignatures = function inspectBoundedSignatures<Value>(
  checker: Checker,
  resolution: FocusedExportResolution,
  projection: SignatureProjection<Value>
): readonly Value[] {
  let totalBytes = 0;

  return orderedSignatureCandidates(checker, resolution).map((candidate) => {
    const inspectedSignature = projection.project(candidate);

    const signatureBytes = Buffer.byteLength(
      projection.serializeForBudget(inspectedSignature)
    );

    totalBytes += signatureBytes;

    if (
      signatureBytes > MAX_SIGNATURE_BYTES ||
      totalBytes > MAX_SIGNATURE_TOTAL_BYTES
    ) {
      throw new InspectionLimitError(
        "signature-bytes",
        "Inspection exceeded its Module Export signature byte limit."
      );
    }

    return projection.retain(inspectedSignature);
  });
};

/** Projects complete structured signatures under the shared visibility, ordering and byte policy. */
export const inspectResolvedExportSignatureDetails =
  function inspectResolvedExportSignatureDetails(
    checker: Checker,
    resolution: FocusedExportResolution,
    retainSignature: (value: InspectedSignature) => InspectedSignature
  ): readonly InspectedSignature[] {
    return inspectBoundedSignatures(checker, resolution, {
      project: ({ kind, signature, signatureKind }) =>
        inspectSignatureDetails(
          checker,
          kind,
          signature,
          signatureKind,
          signatureDeclaration(resolution.targetSymbol)
        ),
      retain: retainSignature,
      serializeForBudget: (signature) => JSON.stringify(signature),
    });
  };

export const inspectResolvedExportSignatures =
  function inspectResolvedExportSignatures(
    checker: Checker,
    resolution: FocusedExportResolution,
    retainSignature: (value: ExportSignature) => ExportSignature
  ): readonly ExportSignature[] {
    return inspectBoundedSignatures(checker, resolution, {
      project: ({ kind, signature, signatureKind }) => ({
        kind,
        text: signatureText(
          checker,
          signature,
          signature.declaration?.resolve() ??
            signatureDeclaration(resolution.targetSymbol),
          signatureKind
        ),
      }),
      retain: retainSignature,
      serializeForBudget: ({ text }) => text,
    });
  };
