/** Fails when runtime data reaches a branch excluded by an exhaustive union. */
export const unreachableCase = (value: never): never => {
  throw new Error("Unexpected variant.", { cause: value });
};
