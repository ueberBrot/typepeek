import { createScanner, LanguageVariant, SyntaxKind } from "tsrs/ast";

export const signatureFact = function signatureFact(
  kind: string,
  text: string
): string {
  const scanner = createScanner(true, LanguageVariant.Standard, text);

  const tokens: string[] = [];

  for (
    let token = scanner.scan();
    token !== SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    tokens.push(
      token === SyntaxKind.StringLiteral
        ? JSON.stringify(scanner.getTokenValue())
        : scanner.getTokenText()
    );
  }

  const canonical = tokens.filter((token, index) => {
    if (
      token === "," &&
      [")", "]", "}", ">"].includes(tokens[index + 1] ?? "")
    ) {
      return false;
    }

    if (
      ["|", "&"].includes(token) &&
      [":", "=", "(", "=>", ",", "<"].includes(tokens[index - 1] ?? "")
    ) {
      return false;
    }

    return true;
  });

  return `${kind}:${canonical.join(" ")}`;
};
