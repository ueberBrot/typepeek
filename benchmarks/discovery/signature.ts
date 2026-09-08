import ts from "@typescript/typescript6";

/** Compare exact declaration tokens, ignoring only trivia and quote style. */
export function signatureFact(kind: string, text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(
      token === ts.SyntaxKind.StringLiteral
        ? JSON.stringify(scanner.getTokenValue())
        : scanner.getTokenText(),
    );
  }
  const canonical = tokens.filter((token, index) => {
    // A leading union/intersection operator and a trailing list comma are optional syntax.
    if (token === "," && [")", "]", "}", ">"].includes(tokens[index + 1] ?? "")) return false;
    if (
      ["|", "&"].includes(token) &&
      [":", "=", "(", "=>", ",", "<"].includes(tokens[index - 1] ?? "")
    )
      return false;
    return true;
  });
  return `${kind}:${canonical.join(" ")}`;
}
