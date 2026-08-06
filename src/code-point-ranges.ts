export type CodePointRange = readonly [start: number, end: number];

export function isCodePointInRanges(codePoint: number, ranges: readonly CodePointRange[]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => codePoint >= rangeStart && codePoint <= rangeEnd);
}
