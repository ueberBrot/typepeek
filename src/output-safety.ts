import { isCodePointInRanges, type CodePointRange } from "#typepeek/code-point-ranges";

const UNSAFE_OUTPUT_RANGES: readonly CodePointRange[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

function isUnsafeOutputCodePoint(codePoint: number): boolean {
  return isCodePointInRanges(codePoint, UNSAFE_OUTPUT_RANGES);
}

/** Escapes one dynamic value so it cannot acquire terminal control semantics. */
export function terminalSafeLine(value: string): string {
  return Array.from(value, terminalSafeCharacter).join("");
}

/** Escapes dynamic terminal text while retaining ordinary line separators. */
export function terminalSafeText(value: string): string {
  return Array.from(value, (character) =>
    character === "\n" || character === "\r" || character === "\t"
      ? character
      : terminalSafeCharacter(character),
  ).join("");
}

/** Serializes JSON without allowing any value to acquire terminal control semantics. */
export function serializeTerminalSafeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("A terminal-safe JSON value must be serializable.");
  }
  return Array.from(serialized, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isUnsafeOutputCodePoint(codePoint) ? jsonUnicodeEscape(codePoint) : character;
  }).join("");
}

function jsonUnicodeEscape(codePoint: number): string {
  return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function terminalSafeCharacter(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return isUnsafeOutputCodePoint(codePoint)
    ? `\\u{${codePoint.toString(16).toUpperCase()}}`
    : character;
}
