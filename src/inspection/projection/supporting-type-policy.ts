import { isModuleDeclaration, isStringLiteral } from "tsrs/ast";
import type { Declaration } from "tsrs/ast";

export type SupportingTypeScope =
  | {
      readonly kind: "package";
    }
  | {
      readonly kind: "platform";
      readonly specifier: string;
    };

const belongsToPlatformModule = function belongsToPlatformModule(
  specifier: string,
  declaration: Declaration
): boolean {
  const acceptedNames = new Set([specifier, specifier.slice("node:".length)]);

  for (
    let ancestor = declaration.parent;
    ancestor !== undefined;
    ancestor = ancestor.parent
  ) {
    if (isModuleDeclaration(ancestor) && isStringLiteral(ancestor.name)) {
      return acceptedNames.has(ancestor.name.text);
    }
  }

  return false;
};

/** Keeps Supporting Type expansion within the selected Inspectable Module's Public Interface. */
export const shouldExpandSupportingDeclaration =
  function shouldExpandSupportingDeclaration(
    scope: SupportingTypeScope,
    declaration: Declaration
  ): boolean {
    if (scope.kind === "package") {
      return true;
    }

    return belongsToPlatformModule(scope.specifier, declaration);
  };
