import { describe, expect, it } from "vite-plus/test";

import { snapshotBoundedDataPropertyGraph } from "#typepeek/inspection/model/untrusted-data";

const generousBounds = {
  maximumObjects: 32,
  maximumStringBytes: 64,
  maximumValues: 128,
} as const;

describe("untrusted-data", () => {
  it("accepts an exact serialized-byte boundary and rejects the next byte", () => {
    const value = { first: "alpha", second: "beta" };
    const serializedBytes = Buffer.byteLength(JSON.stringify(value));
    expect([
      JSON.stringify(
        snapshotBoundedDataPropertyGraph(value, {
          ...generousBounds,
          maximumSerializedBytes: serializedBytes,
        })
      ),
      snapshotBoundedDataPropertyGraph(value, {
        ...generousBounds,
        maximumSerializedBytes: serializedBytes - 1,
      }) === undefined,
    ]).toStrictEqual([JSON.stringify(value), true]);
  });

  it("rejects aggregate bytes composed from individually bounded strings", () => {
    const value = { first: "a".repeat(32), second: "b".repeat(32) };
    expect(
      snapshotBoundedDataPropertyGraph(value, {
        ...generousBounds,
        maximumSerializedBytes: 64,
      })
    ).toBeUndefined();
  });

  it("rejects custom prototypes, symbols, and oversized property names", () => {
    const customRecord = { value: true };
    Object.setPrototypeOf(customRecord, { inherited: true });
    customRecord.value = true;
    const customArray = [true];
    Object.setPrototypeOf(customArray, null);
    const symbolRecord = { value: true };
    Object.defineProperty(symbolRecord, Symbol("hidden"), { value: true });
    const oversizedKey = { ["k".repeat(65)]: true };
    expect([
      snapshotBoundedDataPropertyGraph(customRecord, generousBounds) ===
        undefined,
      snapshotBoundedDataPropertyGraph(customArray, generousBounds) ===
        undefined,
      snapshotBoundedDataPropertyGraph(symbolRecord, generousBounds) ===
        undefined,
      snapshotBoundedDataPropertyGraph(oversizedKey, generousBounds) ===
        undefined,
    ]).toStrictEqual([true, true, true, true]);
  });

  it("rejects object and value work-limit exhaustion", () => {
    expect([
      snapshotBoundedDataPropertyGraph(
        { nested: { value: true } },
        { ...generousBounds, maximumObjects: 1 }
      ) === undefined,
      snapshotBoundedDataPropertyGraph(
        { first: true, second: true },
        { ...generousBounds, maximumValues: 2 }
      ) === undefined,
    ]).toStrictEqual([true, true]);
  });
});
