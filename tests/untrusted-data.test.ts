import { expect, it } from "vite-plus/test";

import { snapshotBoundedDataPropertyGraph } from "#typepeek/inspection/untrusted-data";

const generousBounds = {
  maximumObjects: 32,
  maximumStringBytes: 64,
  maximumValues: 128,
} as const;

it("accepts an exact serialized-byte boundary and rejects the next byte", () => {
  const value = { first: "alpha", second: "beta" };
  const serializedBytes = Buffer.byteLength(JSON.stringify(value));

  expect(
    snapshotBoundedDataPropertyGraph(value, {
      ...generousBounds,
      maximumSerializedBytes: serializedBytes,
    }),
  ).toEqual(value);
  expect(
    snapshotBoundedDataPropertyGraph(value, {
      ...generousBounds,
      maximumSerializedBytes: serializedBytes - 1,
    }),
  ).toBeUndefined();
});

it("rejects aggregate bytes composed from individually bounded strings", () => {
  const value = { first: "a".repeat(32), second: "b".repeat(32) };

  expect(
    snapshotBoundedDataPropertyGraph(value, {
      ...generousBounds,
      maximumSerializedBytes: 64,
    }),
  ).toBeUndefined();
});

it("rejects custom prototypes, symbols, and oversized property names", () => {
  const customRecord = Object.create({ inherited: true }) as Record<string, unknown>;
  customRecord["value"] = true;
  const customArray = [true];
  Object.setPrototypeOf(customArray, null);
  const symbolRecord = { value: true } as Record<string | symbol, unknown>;
  symbolRecord[Symbol("hidden")] = true;
  const oversizedKey = { ["k".repeat(65)]: true };

  expect(snapshotBoundedDataPropertyGraph(customRecord, generousBounds)).toBeUndefined();
  expect(snapshotBoundedDataPropertyGraph(customArray, generousBounds)).toBeUndefined();
  expect(snapshotBoundedDataPropertyGraph(symbolRecord, generousBounds)).toBeUndefined();
  expect(snapshotBoundedDataPropertyGraph(oversizedKey, generousBounds)).toBeUndefined();
});

it("rejects object and value work-limit exhaustion", () => {
  expect(
    snapshotBoundedDataPropertyGraph(
      { nested: { value: true } },
      { ...generousBounds, maximumObjects: 1 },
    ),
  ).toBeUndefined();
  expect(
    snapshotBoundedDataPropertyGraph(
      { first: true, second: true },
      { ...generousBounds, maximumValues: 2 },
    ),
  ).toBeUndefined();
});
