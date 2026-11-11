/** Requires the value already established by an enclosing invariant. */
export const requireDefined = <Value>(
  value: Value | null | undefined
): Value => {
  if (value === undefined || value === null) {
    throw new Error("An established value is missing.");
  }

  return value;
};
