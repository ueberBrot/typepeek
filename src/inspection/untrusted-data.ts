/** Snapshots only named own data properties without enumeration or accessor evaluation. */
export function snapshotDataProperties(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isNonArrayRecord(value)) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isNonArrayRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
