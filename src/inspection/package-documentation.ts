import ts from "@typescript/typescript6";

import {
  splitCodePoints,
  isCodePointInRanges,
} from "#typepeek/code-point-ranges";
import type { CodePointRange } from "#typepeek/code-point-ranges";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import type { AliasDeclaration } from "#typepeek/inspection/focused-export";
import type { PackageDocumentation } from "#typepeek/inspection/protocol";

const MAX_DOCUMENTATION_BYTES = 16 * 1024;

const UNSAFE_PRESENTATION_RANGES: readonly CodePointRange[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [1564, 1564],
  [8206, 8207],
  [8234, 8238],
  [8294, 8297],
];

const ANSI_CONTROL_SEQUENCE_PREFIX = String.fromCodePoint(0x1b, 0x5b);

const isAnsiFinalByte = function isAnsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
};

const ansiControlSequenceEnd = function ansiControlSequenceEnd(
  value: string,
  start: number
): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    if (isAnsiFinalByte(value.codePointAt(index) ?? 0)) {
      return index;
    }
  }

  return undefined;
};

const stripAnsiControlSequences = function stripAnsiControlSequences(
  value: string
): string {
  let remainder = value;
  let sanitized = "";

  while (true) {
    const sequenceStart = remainder.indexOf(ANSI_CONTROL_SEQUENCE_PREFIX);

    if (sequenceStart === -1) {
      return sanitized + remainder;
    }

    sanitized += remainder.slice(0, sequenceStart);

    const sequenceEnd = ansiControlSequenceEnd(
      remainder,
      sequenceStart + ANSI_CONTROL_SEQUENCE_PREFIX.length
    );

    remainder =
      sequenceEnd === undefined ? "" : remainder.slice(sequenceEnd + 1);
  }
};

const stripUnsafePresentationCharacters =
  function stripUnsafePresentationCharacters(value: string): string {
    return splitCodePoints(stripAnsiControlSequences(value))
      .filter(
        (character) =>
          !isCodePointInRanges(
            character.codePointAt(0) ?? 0,
            UNSAFE_PRESENTATION_RANGES
          )
      )
      .join("");
  };

const sanitizePackageDocumentation = function sanitizePackageDocumentation(
  documentation: string
): string {
  // Strip presentation controls for every adapter; terminal rendering also escapes its output.
  return stripUnsafePresentationCharacters(
    documentation.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  ).trim();
};

const renderJsDocNodeTag = function renderJsDocNodeTag(
  tag: ts.JSDocTag
): string {
  const comment = ts.getTextOfJSDocComment(tag.comment);

  const generatedText1 = comment === undefined ? "" : ` ${comment}`;

  return `@${tag.tagName.text}${generatedText1}`;
};

const jsDocNodeText = function jsDocNodeText(
  node: ts.JSDoc | ts.JSDocTag
): readonly string[] {
  if (ts.isJSDoc(node)) {
    return [
      ts.getTextOfJSDocComment(node.comment) ?? "",
      ...(node.tags?.map((tag) => renderJsDocNodeTag(tag)) ?? []),
    ];
  }

  return [renderJsDocNodeTag(node)];
};

const aliasDocumentation = function aliasDocumentation(
  aliasDeclaration: AliasDeclaration | undefined
): string {
  if (aliasDeclaration === undefined) {
    return "";
  }

  const readHost = () => {
    if (ts.isExportSpecifier(aliasDeclaration)) {
      return aliasDeclaration.parent.parent;
    }

    if (ts.isNamespaceExport(aliasDeclaration)) {
      return aliasDeclaration.parent;
    }

    return aliasDeclaration;
  };

  const host = readHost();

  return ts
    .getJSDocCommentsAndTags(host)
    .flatMap(jsDocNodeText)
    .filter((comment) => comment.length > 0)
    .join("\n");
};

const renderJsDocTag = function renderJsDocTag(tag: ts.JSDocTagInfo): string {
  const text =
    tag.text === undefined ? "" : ` ${ts.displayPartsToString(tag.text)}`;

  return `@${tag.name}${text}`;
};

const symbolDocumentation = function symbolDocumentation(
  symbol: ts.Symbol,
  checker: ts.TypeChecker
): string {
  return [
    ts.displayPartsToString(symbol.getDocumentationComment(checker)),
    ...symbol.getJsDocTags(checker).map(renderJsDocTag),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
};

const packageDocumentationText = function packageDocumentationText(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined
): string {
  // Prefer the documentation closest to what the caller selected. Combining
  // layers would duplicate tags and blur alias-specific guidance.
  return (
    [
      aliasDocumentation(aliasDeclaration),
      symbolDocumentation(exportedSymbol, checker),
      symbolDocumentation(targetSymbol, checker),
    ].find((documentation) => documentation.length > 0) ?? ""
  );
};

/**
 * Extracts the first attached Package Documentation visible on an alias, export,
 * or target symbol. Returned text is marked untrusted, sanitized before leaving
 * the Inspection Core, and rejected when it exceeds the documentation budget.
 */
export const inspectPackageDocumentation = function inspectPackageDocumentation(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined
): PackageDocumentation | undefined {
  const documentation = sanitizePackageDocumentation(
    packageDocumentationText(
      checker,
      exportedSymbol,
      targetSymbol,
      aliasDeclaration
    )
  );

  if (documentation.length === 0) {
    return undefined;
  }

  if (Buffer.byteLength(documentation) > MAX_DOCUMENTATION_BYTES) {
    throw new InspectionLimitError(
      "package-documentation",
      "Inspection exceeded its Package Documentation limit."
    );
  }

  return {
    provenance: "installed-evidence",
    text: documentation,
    trust: "untrusted",
  };
};
