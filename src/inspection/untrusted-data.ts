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

export interface BoundedDataPropertyGraphOptions {
  readonly maximumObjects: number;
  readonly maximumValues: number;
  readonly maximumSerializedBytes?: number;
  readonly maximumStringBytes?: number;
}

/**
 * Copies a bounded graph of dense arrays and plain own data-property records.
 * When a serialized-byte bound is supplied, only acyclic JSON data is accepted
 * and shared acyclic values are charged for every serialized occurrence.
 */
export function snapshotBoundedDataPropertyGraph(
  value: unknown,
  options: BoundedDataPropertyGraphOptions,
): unknown {
  if (!isBoundedString(value, options.maximumStringBytes)) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return hasBoundedSerializedSize(value, options) ? value : undefined;
  }
  const root = createSnapshotContainer(value);
  if (root === undefined) {
    return undefined;
  }
  const state: SnapshotState = {
    options,
    pending: [{ source: value, target: root }],
    snapshots: new Map([[value, root]]),
    values: 1,
  };

  for (let cursor = 0; cursor < state.pending.length; cursor += 1) {
    const item = state.pending[cursor] as PendingSnapshot;
    if (!copySnapshotProperties(state, item)) {
      return undefined;
    }
  }
  return hasBoundedSerializedSize(root, options) ? root : undefined;
}

type SnapshotContainer = unknown[] | Record<string, unknown>;
interface PendingSnapshot {
  readonly source: object;
  readonly target: SnapshotContainer;
}
interface SnapshotState {
  readonly options: BoundedDataPropertyGraphOptions;
  readonly pending: PendingSnapshot[];
  readonly snapshots: Map<object, SnapshotContainer>;
  values: number;
}

function copySnapshotProperties(state: SnapshotState, item: PendingSnapshot): boolean {
  const entries = ownDataPropertyEntries(item.source, state.options.maximumValues - state.values);
  if (entries === undefined) {
    return false;
  }
  state.values += entries.length;
  for (const entry of entries) {
    if (!copySnapshotProperty(state, item.target, entry)) {
      return false;
    }
  }
  return true;
}

function copySnapshotProperty(
  state: SnapshotState,
  target: SnapshotContainer,
  [key, child]: readonly [string, unknown],
): boolean {
  if (
    !isBoundedString(key, state.options.maximumStringBytes) ||
    !isBoundedString(child, state.options.maximumStringBytes)
  ) {
    return false;
  }
  if (typeof child !== "object" || child === null) {
    defineSnapshotProperty(target, key, child);
    return true;
  }
  const childSnapshot = findOrCreateSnapshot(state, child);
  if (childSnapshot === undefined) {
    return false;
  }
  defineSnapshotProperty(target, key, childSnapshot);
  return true;
}

function findOrCreateSnapshot(state: SnapshotState, value: object): SnapshotContainer | undefined {
  const existing = state.snapshots.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (state.snapshots.size >= state.options.maximumObjects) {
    return undefined;
  }
  const snapshot = createSnapshotContainer(value);
  if (snapshot === undefined) {
    return undefined;
  }
  state.snapshots.set(value, snapshot);
  state.pending.push({ source: value, target: snapshot });
  return snapshot;
}

function createSnapshotContainer(value: object): SnapshotContainer | undefined {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const snapshot: unknown[] = [];
    Object.setPrototypeOf(snapshot, null);
    return snapshot;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? Object.create(null) : undefined;
}

function ownDataPropertyEntries(
  value: object,
  remainingValues: number,
): readonly (readonly [string, unknown])[] | undefined {
  return Array.isArray(value)
    ? ownArrayDataPropertyEntries(value, remainingValues)
    : ownRecordDataPropertyEntries(value, remainingValues);
}

function ownArrayDataPropertyEntries(
  value: readonly unknown[],
  remainingValues: number,
): readonly (readonly [string, unknown])[] | undefined {
  if (value.length > remainingValues) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    return undefined;
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    if (key === "length") {
      continue;
    }
    const entry = readOwnDataProperty(value, key);
    if (entry === undefined || !isArrayIndex(entry[0], value)) {
      return undefined;
    }
    entries.push(entry);
  }
  return entries.length === value.length ? entries : undefined;
}

function ownRecordDataPropertyEntries(
  value: object,
  remainingValues: number,
): readonly (readonly [string, unknown])[] | undefined {
  const keys = Reflect.ownKeys(value);
  if (keys.length > remainingValues) {
    return undefined;
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const entry = readOwnDataProperty(value, key);
    if (entry === undefined) {
      return undefined;
    }
    entries.push(entry);
  }
  return entries;
}

export function readOwnDataProperty(
  value: object,
  key: string | symbol,
): readonly [string, unknown] | undefined {
  if (typeof key !== "string") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    ? [key, descriptor.value]
    : undefined;
}

function isArrayIndex(key: string, values: readonly unknown[]): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) && index >= 0 && index < values.length && key === String(index)
  );
}

function defineSnapshotProperty(target: SnapshotContainer, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isBoundedString(value: unknown, maximumBytes: number | undefined): boolean {
  return (
    typeof value !== "string" ||
    maximumBytes === undefined ||
    Buffer.byteLength(value) <= maximumBytes
  );
}

interface JsonValueWork {
  readonly kind: "value";
  readonly value: unknown;
}
interface JsonExitWork {
  readonly kind: "exit";
  readonly value: object;
}
type JsonWork = JsonValueWork | JsonExitWork;

function hasBoundedSerializedSize(
  value: unknown,
  options: BoundedDataPropertyGraphOptions,
): boolean {
  const maximumBytes = options.maximumSerializedBytes;
  if (maximumBytes === undefined) {
    return true;
  }
  const ancestors = new Set<object>();
  const work: JsonWork[] = [{ kind: "value", value }];
  let bytes = 0;
  let values = 0;
  while (work.length > 0) {
    const item = work.pop() as JsonWork;
    if (item.kind === "exit") {
      ancestors.delete(item.value);
      continue;
    }
    values += 1;
    if (values > options.maximumValues) {
      return false;
    }
    const measured = measureJsonPrimitive(item.value);
    if (measured !== undefined) {
      bytes += measured;
    } else if (!measureJsonContainer(item.value, ancestors, work, (amount) => (bytes += amount))) {
      return false;
    }
    if (bytes > maximumBytes) {
      return false;
    }
  }
  return true;
}

function measureJsonPrimitive(value: unknown): number | undefined {
  if (value === null) {
    return 4;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return Buffer.byteLength(JSON.stringify(value));
    case "number":
      return Number.isFinite(value) ? Buffer.byteLength(JSON.stringify(value)) : undefined;
    default:
      return undefined;
  }
}

function measureJsonContainer(
  value: unknown,
  ancestors: Set<object>,
  work: JsonWork[],
  addBytes: (amount: number) => void,
): boolean {
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  work.push({ kind: "exit", value });
  const entries: Array<readonly [string, unknown]> = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      entries.push([String(index), value[index]]);
    }
  } else {
    entries.push(...Object.entries(value));
  }
  addBytes(2 + Math.max(0, entries.length - 1));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, child] = entries[index] as readonly [string, unknown];
    if (!Array.isArray(value)) {
      addBytes(Buffer.byteLength(JSON.stringify(key)) + 1);
    }
    work.push({ kind: "value", value: child });
  }
  return true;
}

function isNonArrayRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
