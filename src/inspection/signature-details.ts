import {
  isFunctionLikeDeclaration,
  isIdentifier,
  isParameterDeclaration,
  isTypeParameterDeclaration,
  SyntaxKind,
} from "tsrs/ast";
import type {
  Declaration,
  Node,
  ParameterDeclaration,
  TypeParameterDeclaration,
} from "tsrs/ast";
import { SymbolFlags, TypeFormatFlags, TypePredicateKind } from "tsrs/sync";
import type {
  Checker,
  Signature,
  SignatureKind,
  Symbol as CompilerSymbol,
  Type,
  TypeParameter,
} from "tsrs/sync";

import {
  emptyArgumentsType,
  declarationsOf,
  valueDeclarationOf,
  signatureText,
  signatureParts,
} from "#typepeek/inspection/compiler-session";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import type {
  InspectedSignature,
  SignatureBinding,
  SignatureParameter,
  SignatureReturn,
  SignatureTypeParameter,
  SignatureTypeParameterModifier,
} from "#typepeek/inspection/protocol";
import { bitwiseAnd, bitwiseOr } from "#typepeek/integer-bits";

const MAX_SIGNATURE_PARAMETERS = 256;
const MAX_SIGNATURE_TYPE_PARAMETERS = 64;

const SIGNATURE_TYPE_FORMAT_FLAGS = bitwiseOr(
  bitwiseOr(
    bitwiseOr(
      TypeFormatFlags.NoTruncation,
      TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
    ),
    TypeFormatFlags.NoTypeReduction
  ),
  TypeFormatFlags.UseSingleQuotesForStringLiteralType
);

const renderSignatureType = function renderSignatureType(
  checker: Checker,
  type: Type,
  location: Node
): string {
  return checker.typeToString(type, location, SIGNATURE_TYPE_FORMAT_FLAGS);
};

const signatureTypeParameterName = function signatureTypeParameterName(
  checker: Checker,
  typeParameter: TypeParameter,
  declaration: TypeParameterDeclaration | undefined,
  location: Node
): string {
  return (
    declaration?.name.text ??
    typeParameter.getSymbol()?.name ??
    renderSignatureType(checker, typeParameter, location)
  );
};

const inspectTypeParameterModifiers = function inspectTypeParameterModifiers(
  declaration: TypeParameterDeclaration | undefined
): readonly SignatureTypeParameterModifier[] {
  return (declaration?.modifiers ?? []).flatMap((modifier) => {
    if (modifier.kind === SyntaxKind.ConstKeyword) {
      return ["const"];
    }

    if (modifier.kind === SyntaxKind.InKeyword) {
      return ["in"];
    }

    return modifier.kind === SyntaxKind.OutKeyword ? ["out"] : [];
  });
};

const signatureTypeParameterConstraint =
  function signatureTypeParameterConstraint(
    checker: Checker,
    typeParameter: TypeParameter,
    declaration: TypeParameterDeclaration | undefined,
    location: Node
  ): Partial<Pick<SignatureTypeParameter, "constraint">> {
    if (
      declaration !== undefined &&
      checker.getTypeAtLocation(declaration) === typeParameter
    ) {
      return declaration.constraint === undefined
        ? {}
        : {
            constraint: declaration.constraint.getText(
              declaration.getSourceFile()
            ),
          };
    }

    const constraint = typeParameter.getConstraint();

    return constraint === undefined
      ? {}
      : { constraint: renderSignatureType(checker, constraint, location) };
  };

const signatureTypeParameterDefault = function signatureTypeParameterDefault(
  checker: Checker,
  typeParameter: TypeParameter,
  location: Node
): Partial<Pick<SignatureTypeParameter, "default">> {
  const defaultType =
    typeParameter.getDefault() ??
    checker.getDefaultFromTypeParameter(typeParameter);

  return defaultType === undefined
    ? {}
    : { default: renderSignatureType(checker, defaultType, location) };
};

const inspectSignatureTypeParameter = function inspectSignatureTypeParameter(
  checker: Checker,
  typeParameter: TypeParameter,
  enclosingDeclaration: Node
): SignatureTypeParameter {
  const declaration = (
    typeParameter.getSymbol() === undefined
      ? []
      : declarationsOf(typeParameter.getSymbol())
  ).find(isTypeParameterDeclaration);

  const location = declaration ?? enclosingDeclaration;

  return {
    modifiers: inspectTypeParameterModifiers(declaration),
    name: signatureTypeParameterName(
      checker,
      typeParameter,
      declaration,
      location
    ),
    ...signatureTypeParameterConstraint(
      checker,
      typeParameter,
      declaration,
      location
    ),
    ...signatureTypeParameterDefault(checker, typeParameter, location),
    synthetic: declaration === undefined,
  };
};

const renderSymbolType = function renderSymbolType(
  checker: Checker,
  symbol: CompilerSymbol,
  location: Node
): string {
  return renderSignatureType(
    checker,
    checker.getTypeOfSymbolAtLocation(symbol, location),
    location
  );
};

const findParameterDeclaration = function findParameterDeclaration(
  symbol: CompilerSymbol
): ParameterDeclaration | undefined {
  const declaration =
    valueDeclarationOf(symbol) ??
    declarationsOf(symbol).find(isParameterDeclaration);

  return declaration !== undefined && isParameterDeclaration(declaration)
    ? declaration
    : undefined;
};

const inspectSignatureBinding = function inspectSignatureBinding(
  symbol: CompilerSymbol,
  declaration: ParameterDeclaration | undefined
): SignatureBinding {
  if (declaration === undefined) {
    return { kind: "identifier", name: symbol.name, synthetic: true };
  }

  return isIdentifier(declaration.name)
    ? { kind: "identifier", name: declaration.name.text, synthetic: false }
    : {
        kind: "pattern",
        text: declaration.name.getText(declaration.getSourceFile()),
      };
};

const restParameterMayBeOmitted = function restParameterMayBeOmitted(
  checker: Checker,
  type: Type
): boolean {
  const emptyArguments = emptyArgumentsType(checker);

  if (!checker.isTupleType(emptyArguments)) {
    throw new UnsupportedInspectionError(
      "The compiler could not describe an empty argument list."
    );
  }

  return checker.isTypeAssignableTo(
    emptyArguments,
    checker.getBaseConstraintOfType(type) ?? type
  );
};

const inspectSignatureParameter = function inspectSignatureParameter(
  checker: Checker,
  symbol: CompilerSymbol,
  enclosingDeclaration: Node
): SignatureParameter {
  const declaration = findParameterDeclaration(symbol);
  const location = declaration ?? enclosingDeclaration;
  const parameterType = checker.getTypeOfSymbolAtLocation(symbol, location);
  const rest = declaration?.dotDotDotToken !== undefined;

  const readOptionalResult = () => {
    if (rest) {
      return restParameterMayBeOmitted(checker, parameterType);
    }

    if (declaration === undefined) {
      return bitwiseAnd(symbol.flags, SymbolFlags.Optional) !== 0;
    }

    if (declaration.questionToken !== undefined) {
      return true;
    }

    if (declaration.initializer === undefined) {
      return false;
    }

    const { parent } = declaration;

    return (
      isFunctionLikeDeclaration(parent) &&
      !parent.parameters
        .slice(parent.parameters.indexOf(declaration) + 1)
        .some(
          (parameter) =>
            parameter.questionToken === undefined &&
            parameter.initializer === undefined &&
            parameter.dotDotDotToken === undefined
        )
    );
  };

  const optionalResult = readOptionalResult();

  return {
    binding: inspectSignatureBinding(symbol, declaration),
    optional: optionalResult,
    rest,
    type: renderSignatureType(checker, parameterType, location),
  };
};

const inspectSignatureReturn = function inspectSignatureReturn(
  checker: Checker,
  signature: Signature,
  declaration: Node
): SignatureReturn {
  const predicate = checker.getTypePredicateOfSignature(signature);

  if (predicate === undefined) {
    return {
      kind: "type",
      type: renderSignatureType(
        checker,
        checker.getReturnTypeOfSignature(signature),
        declaration
      ),
    };
  }

  const parameter =
    predicate.kind === TypePredicateKind.This ||
    predicate.kind === TypePredicateKind.AssertsThis
      ? "this"
      : predicate.parameterName;

  if (
    predicate.kind === TypePredicateKind.AssertsThis ||
    predicate.kind === TypePredicateKind.AssertsIdentifier
  ) {
    return {
      kind: "assertion",
      parameter,
      ...(predicate.type !== undefined && {
        type: renderSignatureType(checker, predicate.type, declaration),
      }),
    };
  }

  return {
    kind: "predicate",
    parameter,
    type: renderSignatureType(checker, predicate.type, declaration),
  };
};

/** Renders structured invocation evidence without changing signature selection or byte accounting. */
export const inspectSignatureDetails = function inspectSignatureDetails(
  checker: Checker,
  kind: InspectedSignature["kind"],
  signature: Signature,
  signatureKind: SignatureKind,
  fallbackDeclaration: Declaration | undefined
): InspectedSignature {
  // The native checker synthesizes implicit class constructors without a
  // signature declaration. The exported class supplies their source context.
  const declaration = signature.declaration?.resolve() ?? fallbackDeclaration;

  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "A public signature has no declaration evidence."
    );
  }

  const { parameters, typeParameters, thisParameter } = signatureParts(
    checker,
    signature
  );

  if (parameters.length > MAX_SIGNATURE_PARAMETERS) {
    throw new InspectionLimitError(
      "signature-parameters",
      "Inspection exceeded its signature parameter limit."
    );
  }

  if (typeParameters.length > MAX_SIGNATURE_TYPE_PARAMETERS) {
    throw new InspectionLimitError(
      "signature-type-parameters",
      "Inspection exceeded its signature type parameter limit."
    );
  }

  return {
    kind,
    text: signatureText(checker, signature, declaration, signatureKind),
    typeParameters: typeParameters.map((item) =>
      inspectSignatureTypeParameter(checker, item, declaration)
    ),
    ...(thisParameter !== undefined && {
      thisParameter: {
        type: renderSymbolType(checker, thisParameter, declaration),
      },
    }),
    parameters: parameters.map((item) =>
      inspectSignatureParameter(checker, item, declaration)
    ),
    returns: inspectSignatureReturn(checker, signature, declaration),
  };
};
