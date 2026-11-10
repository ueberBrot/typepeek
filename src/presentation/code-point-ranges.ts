export type CodePointRange = readonly [start: number, end: number];

export const isCodePointInRanges = function isCodePointInRanges(
  codePoint: number,
  ranges: readonly CodePointRange[]
): boolean {
  return ranges.some(
    ([rangeStart, rangeEnd]) => codePoint >= rangeStart && codePoint <= rangeEnd
  );
};

/** Splits text into Unicode code points for per-code-point validation. */
export const splitCodePoints = (text: string): string[] => [
  ...text[Symbol.iterator](),
];
