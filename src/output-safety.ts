import { isCodePointInRanges, type CodePointRange } from "#typepeek/code-point-ranges";

const UNSAFE_OUTPUT_RANGES: readonly CodePointRange[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

export function isUnsafeOutputCodePoint(codePoint: number): boolean {
  return isCodePointInRanges(codePoint, UNSAFE_OUTPUT_RANGES);
}
