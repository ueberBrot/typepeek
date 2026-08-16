import { execa } from "execa";
import { expect, it } from "vite-plus/test";

it("benchmarks successful source-checkout inspections through the CLI seam", async () => {
  const result = await execa(process.execPath, [
    "benchmarks/inspection-latency.ts",
    "--adapter",
    "source",
    "--iterations",
    "1",
    "--json",
  ]);

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "inspection-latency-benchmark",
    schemaVersion: 1,
    adapter: "source",
    iterations: 1,
    cases: [
      { name: "interface-overview", statuses: ["success"] },
      { name: "signature-inspection", statuses: ["success"] },
    ],
  });
});
