/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters -- Own-property snapshots precede domain schemas and must represent hostile JavaScript values, accessors, and cycles. */
import { Predicate } from "effect";

import { requireDefined } from "#typepeek/defined-value";

/** An own-data-property snapshot that still requires its domain schema. */
export interface DataPropertySnapshot {
  readonly [key: string]: unknown;
}

/** Snapshots only named own data properties without enumeration or accessor evaluation. */
export const snapshotDataProperties = function snapshotDataProperties(
  value: unknown,
  fields: readonly string[]
): DataPropertySnapshot | undefined {
  if (!Predicate.isReadonlyObject(value)) {
    return undefined;
  }

  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);

  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined) {
      continue;
    }

    if (!("value" in descriptor)) {
      return undefined;
    }

    const data: unknown = descriptor.value;
    snapshot[key] = data;
  }

  return snapshot;
};

export interface BoundedDataPropertyGraphOptions {
  readonly maximumObjects: number;
  readonly maximumValues: number;
  readonly maximumSerializedBytes?: number;
  readonly maximumStringBytes?: number;
}

const isBoundedString = function isBoundedString(
  value: unknown,
  maximumBytes: number | undefined
): boolean {
  return (
    !Predicate.isString(value) ||
    maximumBytes === undefined ||
    Buffer.byteLength(value) <= maximumBytes
  );
};

const measureJsonPrimitive = function measureJsonPrimitive(
  value: unknown
): number | undefined {
  if (value === null) {
    return 4;
  }

  if (
    Predicate.isString(value) ||
    Predicate.isBoolean(value) ||
    (Predicate.isNumber(value) && Number.isFinite(value))
  ) {
    return Buffer.byteLength(JSON.stringify(value));
  }

  return undefined;
};

const measureJsonContainer = function measureJsonContainer(
  value: unknown,
  ancestors: Set<object>,
  work: JsonWork[],
  addBytes: (amount: number) => void
): boolean {
  if (!Predicate.isObjectOrArray(value) || ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  work.push({ kind: "exit", value });

  const entries: (readonly [string, unknown])[] = [];

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      entries.push([String(index), value[index]]);
    }
  } else {
    entries.push(...Object.entries(value));
  }

  addBytes(2 + Math.max(0, entries.length - 1));

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, child] = requireDefined(entries[index]);

    if (!Array.isArray(value)) {
      addBytes(Buffer.byteLength(JSON.stringify(key)) + 1);
    }

    work.push({ kind: "value", value: child });
  }

  return true;
};

const hasBoundedSerializedSize = function hasBoundedSerializedSize(
  value: unknown,
  options: BoundedDataPropertyGraphOptions
): boolean {
  const maximumBytes = options.maximumSerializedBytes;

  if (maximumBytes === undefined) {
    return true;
  }

  const ancestors = new Set<object>();
  const work: JsonWork[] = [{ kind: "value", value }];
  let bytes = 0;
  let values = 0;

  const recordBytes = (amount: number): void => {
    bytes += amount;
  };

  while (work.length > 0) {
    const item = requireDefined(work.pop());

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
    } else if (
      !measureJsonContainer(item.value, ancestors, work, recordBytes)
    ) {
      return false;
    }

    if (bytes > maximumBytes) {
      return false;
    }
  }

  return true;
};

const createSnapshotContainer = function createSnapshotContainer(
  value: object
): SnapshotContainer | undefined {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }

    const snapshot: unknown[] = [];
    Object.setPrototypeOf(snapshot, null);

    return snapshot;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }

  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);

  return snapshot;
};

const readOwnDataProperty = function readOwnDataProperty(
  value: object,
  key: string | symbol
): readonly [string, unknown] | undefined {
  if (!Predicate.isString(key)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);

  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    return undefined;
  }

  return [key, descriptor.value];
};

/** Reads a typed owner's own data property without invoking getters or inherited properties. */
export const readOwnOptionalProperty = function readOwnOptionalProperty<
  Value extends object,
  Key extends keyof Value & string,
>(value: Value, key: Key): Value[Key] | undefined {
  const entry = readOwnDataProperty(value, key);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The owner's declared property type applies to its own data descriptor; accessors and inherited values were excluded above.
  return entry?.[1] as Value[Key] | undefined;
};

const isArrayIndex = function isArrayIndex(
  key: string,
  values: readonly unknown[]
): boolean {
  const index = Number(key);

  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < values.length &&
    key === String(index)
  );
};

const ownArrayDataPropertyEntries = function ownArrayDataPropertyEntries(
  value: readonly unknown[],
  remainingValues: number
): readonly (readonly [string, unknown])[] | undefined {
  if (value.length > remainingValues) {
    return undefined;
  }

  const keys = Reflect.ownKeys(value);

  if (keys.length !== value.length + 1) {
    return undefined;
  }

  const entries: (readonly [string, unknown])[] = [];

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
};

const ownRecordDataPropertyEntries = function ownRecordDataPropertyEntries(
  value: object,
  remainingValues: number
): readonly (readonly [string, unknown])[] | undefined {
  const keys = Reflect.ownKeys(value);

  if (keys.length > remainingValues) {
    return undefined;
  }

  const entries: (readonly [string, unknown])[] = [];

  for (const key of keys) {
    const entry = readOwnDataProperty(value, key);

    if (entry === undefined) {
      return undefined;
    }

    entries.push(entry);
  }

  return entries;
};

const ownDataPropertyEntries = function ownDataPropertyEntries(
  value: object,
  remainingValues: number
): readonly (readonly [string, unknown])[] | undefined {
  return Array.isArray(value)
    ? ownArrayDataPropertyEntries(value, remainingValues)
    : ownRecordDataPropertyEntries(value, remainingValues);
};

const defineSnapshotProperty = function defineSnapshotProperty(
  target: SnapshotContainer,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const findOrCreateSnapshot = function findOrCreateSnapshot(
  state: SnapshotState,
  value: object
): SnapshotContainer | undefined {
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
};

const copySnapshotProperty = function copySnapshotProperty(
  state: SnapshotState,
  target: SnapshotContainer,
  [key, child]: readonly [string, unknown]
): boolean {
  if (
    !isBoundedString(key, state.options.maximumStringBytes) ||
    !isBoundedString(child, state.options.maximumStringBytes)
  ) {
    return false;
  }

  if (!Predicate.isObjectOrArray(child)) {
    defineSnapshotProperty(target, key, child);

    return true;
  }

  const childSnapshot = findOrCreateSnapshot(state, child);

  if (childSnapshot === undefined) {
    return false;
  }

  defineSnapshotProperty(target, key, childSnapshot);

  return true;
};

const copySnapshotProperties = function copySnapshotProperties(
  state: SnapshotState,
  item: PendingSnapshot
): boolean {
  const entries = ownDataPropertyEntries(
    item.source,
    state.options.maximumValues - state.values
  );

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
};

/**
 * Copies a bounded graph of dense arrays and plain own data-property records.
 * When a serialized-byte bound is supplied, only acyclic JSON data is accepted
 * and shared acyclic values are charged for every serialized occurrence.
 */
export const snapshotBoundedDataPropertyGraph =
  function snapshotBoundedDataPropertyGraph(
    value: unknown,
    options: BoundedDataPropertyGraphOptions
  ): unknown {
    if (!isBoundedString(value, options.maximumStringBytes)) {
      return undefined;
    }

    if (!Predicate.isObjectOrArray(value)) {
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

    for (const item of state.pending) {
      if (!copySnapshotProperties(state, item)) {
        return undefined;
      }
    }

    return hasBoundedSerializedSize(root, options) ? root : undefined;
  };

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

interface JsonValueWork {
  readonly kind: "value";
  readonly value: unknown;
}

interface JsonExitWork {
  readonly kind: "exit";
  readonly value: object;
}

type JsonWork = JsonValueWork | JsonExitWork;
