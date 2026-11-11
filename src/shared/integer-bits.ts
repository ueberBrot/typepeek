/* oxlint-disable eslint/no-bitwise -- Compiler flags, file modes, and seeded hashes require JavaScript's integer bit operations. */
export const bitwiseAnd = (left: number, right: number): number => left & right;
export const bitwiseOr = (left: number, right: number): number => left | right;

export const unsignedRightShift = (value: number, count: number): number =>
  value >>> count;
