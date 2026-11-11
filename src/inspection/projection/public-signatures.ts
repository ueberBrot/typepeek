import {
  isClassDeclaration,
  isConstructorDeclaration,
  isConstructorTypeNode,
  SyntaxKind,
} from "tsrs/ast";
import type { Declaration, Node } from "tsrs/ast";
import { SignatureKind } from "tsrs/async";
import type {
  Checker,
  Signature,
  Symbol as CompilerSymbol,
  Type,
} from "tsrs/async";

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
import { mapAsync } from "#typepeek/shared/async-collection";

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
  readonly project: (candidate: SignatureCandidate) => Value | Promise<Value>;
  readonly retain: (value: Value) => Value;
  readonly serializeForBudget: (value: Value) => string;
}

const signatureDeclaration = async function signatureDeclaration(
  symbol: CompilerSymbol
): Promise<Declaration | undefined> {
  const value = await valueDeclarationOf(symbol);

  if (value !== undefined) {
    return value;
  }

  const declarations = await declarationsOf(symbol);

  return declarations[0];
};

const signatureType = async function signatureType(
  checker: Checker,
  symbol: CompilerSymbol,
  declaration: Declaration,
  valueAccessible: boolean
): Promise<Type> {
  return valueAccessible
    ? await checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : await checker.getDeclaredTypeOfSymbol(symbol);
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

const isPublicConstructorSignature =
  async function isPublicConstructorSignature(
    signature: Signature
  ): Promise<boolean> {
    const declaration = await signature.declaration?.resolve();

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

const appendSignatureCandidates = async function appendSignatureCandidates(
  candidates: SignatureCandidate[],
  checker: Checker,
  type: Type,
  signatureKind: SignatureKind,
  kind: ExportSignature["kind"]
): Promise<void> {
  const signatures = await checker.getSignaturesOfType(type, signatureKind);

  /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
  for (const [compilerOrder, signature] of signatures.entries()) {
    if (
      signatureKind === SignatureKind.Construct &&
      !(await isPublicConstructorSignature(signature))
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
  /* oxlint-enable eslint/no-await-in-loop */
};

const symbolDeclarations = async function symbolDeclarations(
  symbol: CompilerSymbol | undefined
): Promise<readonly Declaration[]> {
  return (await declarationsOf(symbol)) ?? [];
};

const declarationSourceOrder = async function declarationSourceOrder(
  symbol: CompilerSymbol,
  type: Type
): Promise<ReadonlyMap<string, number>> {
  // TypeScript preserves order within one source file but can interleave
  // signatures from merged declarations. Rank their source files explicitly.
  const declarations = [
    ...(await symbolDeclarations(symbol)),
    ...(await symbolDeclarations(await type.getSymbol())),
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
  sourceOrder: ReadonlyMap<string, number>,
  declarations: ReadonlyMap<SignatureCandidate, Declaration | undefined>
): number {
  const leftDeclaration = declarations.get(left);
  const rightDeclaration = declarations.get(right);

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

const orderedSignatureCandidates = async function orderedSignatureCandidates(
  checker: Checker,
  resolution: FocusedExportResolution
): Promise<SignatureCandidate[]> {
  const symbol = resolution.targetSymbol;
  const declaration = await signatureDeclaration(symbol);

  if (declaration === undefined) {
    return [];
  }

  const type = await signatureType(
    checker,
    symbol,
    declaration,
    resolution.valueAccessible
  );

  const candidates: SignatureCandidate[] = [];
  await appendSignatureCandidates(
    candidates,
    checker,
    type,
    SignatureKind.Call,
    "call"
  );
  await appendSignatureCandidates(
    candidates,
    checker,
    type,
    SignatureKind.Construct,
    "construct"
  );
  const sourceOrder = await declarationSourceOrder(symbol, type);
  const declarations = new Map<SignatureCandidate, Declaration | undefined>();
  await mapAsync(candidates, async (candidate) => {
    declarations.set(
      candidate,
      await candidate.signature.declaration?.resolve()
    );
  });
  candidates.sort((left, right) =>
    compareSignatureCandidates(left, right, sourceOrder, declarations)
  );

  return candidates;
};

const inspectBoundedSignatures = async function inspectBoundedSignatures<Value>(
  checker: Checker,
  resolution: FocusedExportResolution,
  projection: SignatureProjection<Value>
): Promise<readonly Value[]> {
  let totalBytes = 0;

  return await mapAsync(
    await orderedSignatureCandidates(checker, resolution),
    async (candidate) => {
      const inspectedSignature = await projection.project(candidate);

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
    }
  );
};

/** Projects complete structured signatures under the shared visibility, ordering and byte policy. */
export const inspectResolvedExportSignatureDetails =
  async function inspectResolvedExportSignatureDetails(
    checker: Checker,
    resolution: FocusedExportResolution,
    retainSignature: (value: InspectedSignature) => InspectedSignature
  ): Promise<readonly InspectedSignature[]> {
    return await inspectBoundedSignatures(checker, resolution, {
      project: async ({ kind, signature, signatureKind }) =>
        await inspectSignatureDetails(
          checker,
          kind,
          signature,
          signatureKind,
          await signatureDeclaration(resolution.targetSymbol)
        ),
      retain: retainSignature,
      serializeForBudget: (signature) => JSON.stringify(signature),
    });
  };

export const inspectResolvedExportSignatures =
  async function inspectResolvedExportSignatures(
    checker: Checker,
    resolution: FocusedExportResolution,
    retainSignature: (value: ExportSignature) => ExportSignature
  ): Promise<readonly ExportSignature[]> {
    return await inspectBoundedSignatures(checker, resolution, {
      project: async ({ kind, signature, signatureKind }) => ({
        kind,
        text: await signatureText(
          checker,
          signature,
          (await signature.declaration?.resolve()) ??
            (await signatureDeclaration(resolution.targetSymbol)),
          signatureKind
        ),
      }),
      retain: retainSignature,
      serializeForBudget: ({ text }) => text,
    });
  };
