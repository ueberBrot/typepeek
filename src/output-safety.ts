import type { CodePointRange } from "#typepeek/code-point-ranges";
import { isCodePointInRanges } from "#typepeek/code-point-ranges";

const UNSAFE_OUTPUT_RANGES: readonly CodePointRange[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [1564, 1564],
  [8206, 8207],
  [8232, 8238],
  [8294, 8297],
];

const isUnsafeOutputCodePoint = function isUnsafeOutputCodePoint(
  codePoint: number
): boolean {
  return isCodePointInRanges(codePoint, UNSAFE_OUTPUT_RANGES);
};

const terminalSafeCharacter = function terminalSafeCharacter(
  character: string
): string {
  const codePoint = character.codePointAt(0) ?? 0;

  return isUnsafeOutputCodePoint(codePoint)
    ? `\\u{${codePoint.toString(16).toUpperCase()}}`
    : character;
};

/** Escapes control characters in a terminal value. */
export const terminalSafeLine = function terminalSafeLine(
  value: string
): string {
  return Array.from(value, terminalSafeCharacter).join("");
};

const jsonUnicodeEscape = function jsonUnicodeEscape(
  codePoint: number
): string {
  return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
};

/** Escapes control characters in JSON while preserving pretty-print line breaks. */
export const serializeTerminalSafeJson = function serializeTerminalSafeJson(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON encoding is the output boundary; typed domain objects need no open index signature, and unserializable values fail below.
  value: unknown,
  pretty = false
): string {
  const serialized = JSON.stringify(value, undefined, pretty ? 2 : undefined);

  if (serialized === undefined) {
    throw new TypeError("A terminal-safe JSON value must be serializable.");
  }

  return Array.from(serialized, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;

    // JSON.stringify escapes newlines inside values; remaining newlines belong to the layout.
    if (pretty && codePoint === 0x0a) {
      return character;
    }

    return isUnsafeOutputCodePoint(codePoint)
      ? jsonUnicodeEscape(codePoint)
      : character;
  }).join("");
};
