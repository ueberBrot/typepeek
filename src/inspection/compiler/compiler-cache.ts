/** Reuses compiler lookups, including cached misses represented by undefined. */
export const cachedCompilerLookup = <Value>(
  cache: Map<string, Value>,
  key: string,
  read: () => Value
): Value => {
  if (cache.has(key)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Map.has proves this key has a Value, including an intentionally cached undefined or null.
    return cache.get(key) as Value;
  }

  const value = read();
  cache.set(key, value);

  return value;
};
