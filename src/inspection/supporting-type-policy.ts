import ts from "@typescript/typescript6";

export type SupportingTypeScope =
  | { readonly kind: "package" }
  | { readonly kind: "platform"; readonly specifier: string };

/** Keeps Supporting Type expansion within the selected Inspectable Module's Public Interface. */
export function shouldExpandSupportingDeclaration(
  scope: SupportingTypeScope,
  declaration: ts.Declaration,
): boolean {
  if (scope.kind === "package") {
    return true;
  }
  return belongsToPlatformModule(scope.specifier, declaration);
}

function belongsToPlatformModule(specifier: string, declaration: ts.Declaration): boolean {
  const acceptedNames = new Set([specifier, specifier.slice("node:".length)]);
  for (let ancestor = declaration.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    if (ts.isModuleDeclaration(ancestor) && ts.isStringLiteral(ancestor.name)) {
      return acceptedNames.has(ancestor.name.text);
    }
  }
  return false;
}
