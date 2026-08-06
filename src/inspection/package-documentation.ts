import ts from "@typescript/typescript6";

import { isCodePointInRanges, type CodePointRange } from "#typepeek/code-point-ranges";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import type { PackageDocumentation } from "#typepeek/inspection/protocol";

const MAX_DOCUMENTATION_BYTES = 16 * 1_024;
const UNSAFE_PRESENTATION_RANGES: readonly CodePointRange[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const ANSI_CONTROL_SEQUENCE_PREFIX = String.fromCodePoint(0x1b, 0x5b);

type AliasDeclaration =
  | ts.ExportAssignment
  | ts.ExportSpecifier
  | ts.ImportEqualsDeclaration
  | ts.NamespaceExport;

export function inspectPackageDocumentation(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
): PackageDocumentation | undefined {
  const documentation = sanitizePackageDocumentation(
    packageDocumentationText(checker, exportedSymbol, targetSymbol, aliasDeclaration),
  );
  if (documentation.length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(documentation) > MAX_DOCUMENTATION_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its Package Documentation limit.");
  }
  return {
    provenance: "installed-evidence",
    trust: "untrusted",
    text: documentation,
  };
}

function packageDocumentationText(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
): string {
  return (
    [
      aliasDocumentation(aliasDeclaration),
      symbolDocumentation(exportedSymbol, checker),
      symbolDocumentation(targetSymbol, checker),
    ].find((documentation) => documentation.length > 0) ?? ""
  );
}

function symbolDocumentation(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  return [
    ts.displayPartsToString(symbol.getDocumentationComment(checker)),
    ...symbol.getJsDocTags(checker).map(renderJsDocTag),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function renderJsDocTag(tag: ts.JSDocTagInfo): string {
  const text = tag.text === undefined ? "" : ` ${ts.displayPartsToString(tag.text)}`;
  return `@${tag.name}${text}`;
}

function aliasDocumentation(aliasDeclaration: AliasDeclaration | undefined): string {
  if (aliasDeclaration === undefined) {
    return "";
  }
  const host = ts.isExportSpecifier(aliasDeclaration)
    ? aliasDeclaration.parent.parent
    : ts.isNamespaceExport(aliasDeclaration)
      ? aliasDeclaration.parent
      : aliasDeclaration;
  return ts
    .getJSDocCommentsAndTags(host)
    .flatMap(jsDocNodeText)
    .filter((comment) => comment.length > 0)
    .join("\n");
}

function jsDocNodeText(node: ts.JSDoc | ts.JSDocTag): readonly string[] {
  if (ts.isJSDoc(node)) {
    return [
      ts.getTextOfJSDocComment(node.comment) ?? "",
      ...(node.tags?.map((tag) => renderJsDocNodeTag(tag)) ?? []),
    ];
  }
  return [renderJsDocNodeTag(node)];
}

function renderJsDocNodeTag(tag: ts.JSDocTag): string {
  const comment = ts.getTextOfJSDocComment(tag.comment);
  return `@${tag.tagName.text}${comment === undefined ? "" : ` ${comment}`}`;
}

function sanitizePackageDocumentation(documentation: string): string {
  return stripUnsafePresentationCharacters(
    documentation.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  ).trim();
}

function stripUnsafePresentationCharacters(value: string): string {
  return Array.from(stripAnsiControlSequences(value))
    .filter(
      (character) =>
        !isCodePointInRanges(character.codePointAt(0) ?? 0, UNSAFE_PRESENTATION_RANGES),
    )
    .join("");
}

function stripAnsiControlSequences(value: string): string {
  let remainder = value;
  let sanitized = "";
  while (true) {
    const sequenceStart = remainder.indexOf(ANSI_CONTROL_SEQUENCE_PREFIX);
    if (sequenceStart < 0) {
      return sanitized + remainder;
    }
    sanitized += remainder.slice(0, sequenceStart);
    const sequenceEnd = ansiControlSequenceEnd(
      remainder,
      sequenceStart + ANSI_CONTROL_SEQUENCE_PREFIX.length,
    );
    remainder = sequenceEnd === undefined ? "" : remainder.slice(sequenceEnd + 1);
  }
}

function ansiControlSequenceEnd(value: string, start: number): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    if (isAnsiFinalByte(value.charCodeAt(index))) {
      return index;
    }
  }
  return undefined;
}

function isAnsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}
