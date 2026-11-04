import { describe, expect, it } from "vite-plus/test";

import { cachedCompilerLookup } from "#typepeek/inspection/compiler-cache";

describe("compiler lookup cache", () => {
  it.each([undefined, null, false, 0, ""])(
    "retains a cached %s without repeating the lookup",
    (value) => {
      const cache = new Map<string, typeof value>();
      let reads = 0;

      const read = () => {
        reads += 1;

        return value;
      };

      expect([
        cachedCompilerLookup(cache, "entry", read),
        cachedCompilerLookup(cache, "entry", read),
        reads,
      ]).toStrictEqual([value, value, 1]);
    }
  );
});
