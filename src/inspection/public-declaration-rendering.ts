import ts from "@typescript/typescript6";

import { projectPublicDeclaration } from "#typepeek/inspection/public-declaration-projection";

const declarationPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

/** Renders one semantic Public Interface projection as stable declaration text. */
export function renderPublicDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): string {
  const sourceFile = declaration.getSourceFile();
  return declarationPrinter
    .printNode(
      ts.EmitHint.Unspecified,
      projectPublicDeclaration(checker, declaration).syntax,
      sourceFile,
    )
    .trim()
    .replace(/^(?:export\s+)?(?:declare\s+)?/u, "");
}
