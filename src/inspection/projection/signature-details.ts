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
import { SymbolFlags, TypeFormatFlags, TypePredicateKind } from "tsrs/async";
import type {
  Checker,
  Signature,
  SignatureKind,
  Symbol as CompilerSymbol,
  Type,
  TypeParameter,
} from "tsrs/async";

import { mergeCompilerFlags } from "#typepeek/inspection/compiler/compiler-flags";
import {
  emptyArgumentsType,
  declarationsOf,
  valueDeclarationOf,
  signatureText,
  signatureParts,
} from "#typepeek/inspection/compiler/compiler-session";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type {
  InspectedSignature,
  SignatureBinding,
  SignatureParameter,
  SignatureReturn,
  SignatureTypeParameter,
  SignatureTypeParameterModifier,
} from "#typepeek/inspection/model/protocol";
import { mapAsync } from "#typepeek/shared/async-collection";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

const MAX_SIGNATURE_PARAMETERS = 256;
const MAX_SIGNATURE_TYPE_PARAMETERS = 64;

const SIGNATURE_TYPE_FORMAT_FLAGS = mergeCompilerFlags(
  mergeCompilerFlags(
    mergeCompilerFlags(
      TypeFormatFlags.NoTruncation,
      TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
    ),
    TypeFormatFlags.NoTypeReduction
  ),
  TypeFormatFlags.UseSingleQuotesForStringLiteralType
);

const renderSignatureType = async function renderSignatureType(
  checker: Checker,
  type: Type,
  location: Node
): Promise<string> {
  return await checker.typeToString(
    type,
    location,
    SIGNATURE_TYPE_FORMAT_FLAGS
  );
};

const signatureTypeParameterName = async function signatureTypeParameterName(
  checker: Checker,
  typeParameter: TypeParameter,
  declaration: TypeParameterDeclaration | undefined,
  location: Node
): Promise<string> {
  if (declaration !== undefined) {
    return declaration.name.text;
  }

  const symbol = await typeParameter.getSymbol();

  return (
    symbol?.name ??
    (await renderSignatureType(checker, typeParameter, location))
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
  async function signatureTypeParameterConstraint(
    checker: Checker,
    typeParameter: TypeParameter,
    declaration: TypeParameterDeclaration | undefined,
    location: Node
  ): Promise<Partial<Pick<SignatureTypeParameter, "constraint">>> {
    if (
      declaration !== undefined &&
      (await checker.getTypeAtLocation(declaration)) === typeParameter
    ) {
      return declaration.constraint === undefined
        ? {}
        : {
            constraint: declaration.constraint.getText(
              declaration.getSourceFile()
            ),
          };
    }

    const constraint = await typeParameter.getConstraint();

    return constraint === undefined
      ? {}
      : {
          constraint: await renderSignatureType(checker, constraint, location),
        };
  };

const signatureTypeParameterDefault =
  async function signatureTypeParameterDefault(
    checker: Checker,
    typeParameter: TypeParameter,
    location: Node
  ): Promise<Partial<Pick<SignatureTypeParameter, "default">>> {
    const defaultType =
      (await typeParameter.getDefault()) ??
      (await checker.getDefaultFromTypeParameter(typeParameter));

    return defaultType === undefined
      ? {}
      : { default: await renderSignatureType(checker, defaultType, location) };
  };

const inspectSignatureTypeParameter =
  async function inspectSignatureTypeParameter(
    checker: Checker,
    typeParameter: TypeParameter,
    enclosingDeclaration: Node
  ): Promise<SignatureTypeParameter> {
    const declaration = (
      (await typeParameter.getSymbol()) === undefined
        ? []
        : await declarationsOf(await typeParameter.getSymbol())
    ).find(isTypeParameterDeclaration);

    const location = declaration ?? enclosingDeclaration;

    return {
      modifiers: inspectTypeParameterModifiers(declaration),
      name: await signatureTypeParameterName(
        checker,
        typeParameter,
        declaration,
        location
      ),
      ...(await signatureTypeParameterConstraint(
        checker,
        typeParameter,
        declaration,
        location
      )),
      ...(await signatureTypeParameterDefault(
        checker,
        typeParameter,
        location
      )),
      synthetic: declaration === undefined,
    };
  };

const renderSymbolType = async function renderSymbolType(
  checker: Checker,
  symbol: CompilerSymbol,
  location: Node
): Promise<string> {
  return await renderSignatureType(
    checker,
    await checker.getTypeOfSymbolAtLocation(symbol, location),
    location
  );
};

const findParameterDeclaration = async function findParameterDeclaration(
  symbol: CompilerSymbol
): Promise<ParameterDeclaration | undefined> {
  let declaration = await valueDeclarationOf(symbol);

  if (declaration === undefined) {
    const declarations = await declarationsOf(symbol);
    declaration = declarations.find(isParameterDeclaration);
  }

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

const restParameterMayBeOmitted = async function restParameterMayBeOmitted(
  checker: Checker,
  type: Type
): Promise<boolean> {
  const emptyArguments = await emptyArgumentsType(checker);

  if (!(await checker.isTupleType(emptyArguments))) {
    throw new UnsupportedInspectionError(
      "The compiler could not describe an empty argument list."
    );
  }

  return await checker.isTypeAssignableTo(
    emptyArguments,
    (await checker.getBaseConstraintOfType(type)) ?? type
  );
};

const inspectSignatureParameter = async function inspectSignatureParameter(
  checker: Checker,
  symbol: CompilerSymbol,
  enclosingDeclaration: Node
): Promise<SignatureParameter> {
  const declaration = await findParameterDeclaration(symbol);
  const location = declaration ?? enclosingDeclaration;

  const parameterType = await checker.getTypeOfSymbolAtLocation(
    symbol,
    location
  );

  const rest = declaration?.dotDotDotToken !== undefined;

  const readOptionalResult = async () => {
    if (rest) {
      return await restParameterMayBeOmitted(checker, parameterType);
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

  const optionalResult = await readOptionalResult();

  return {
    binding: inspectSignatureBinding(symbol, declaration),
    optional: optionalResult,
    rest,
    type: await renderSignatureType(checker, parameterType, location),
  };
};

const inspectSignatureReturn = async function inspectSignatureReturn(
  checker: Checker,
  signature: Signature,
  declaration: Node
): Promise<SignatureReturn> {
  const predicate = await checker.getTypePredicateOfSignature(signature);

  if (predicate === undefined) {
    return {
      kind: "type",
      type: await renderSignatureType(
        checker,
        await checker.getReturnTypeOfSignature(signature),
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
        type: await renderSignatureType(checker, predicate.type, declaration),
      }),
    };
  }

  return {
    kind: "predicate",
    parameter,
    type: await renderSignatureType(checker, predicate.type, declaration),
  };
};

/** Renders structured invocation evidence without changing signature selection or byte accounting. */
export const inspectSignatureDetails = async function inspectSignatureDetails(
  checker: Checker,
  kind: InspectedSignature["kind"],
  signature: Signature,
  signatureKind: SignatureKind,
  fallbackDeclaration: Declaration | undefined
): Promise<InspectedSignature> {
  // The native checker synthesizes implicit class constructors without a
  // signature declaration. The exported class supplies their source context.
  const declaration =
    (await signature.declaration?.resolve()) ?? fallbackDeclaration;

  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "A public signature has no declaration evidence."
    );
  }

  const { parameters, typeParameters, thisParameter } = await signatureParts(
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
    text: await signatureText(checker, signature, declaration, signatureKind),
    typeParameters: await mapAsync(
      typeParameters,
      async (item) =>
        await inspectSignatureTypeParameter(checker, item, declaration)
    ),
    ...(thisParameter !== undefined && {
      thisParameter: {
        type: await renderSymbolType(checker, thisParameter, declaration),
      },
    }),
    parameters: await mapAsync(
      parameters,
      async (item) =>
        await inspectSignatureParameter(checker, item, declaration)
    ),
    returns: await inspectSignatureReturn(checker, signature, declaration),
  };
};
