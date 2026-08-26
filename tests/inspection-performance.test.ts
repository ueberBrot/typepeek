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
      { name: "export-search", statuses: ["success"] },
      { name: "public-subpath-discovery", statuses: ["success"] },
    ],
  });
});

it("measures agent protocol projection and recovery workloads", async () => {
  const result = await execa(process.execPath, ["benchmarks/agent-protocol.ts"]);

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "agent-protocol-benchmark",
    schemaVersion: 1,
    protocolVersion: "1",
    workloads: [
      {
        id: "execa-invocation",
        passed: true,
        reductionRatio: expect.any(Number),
      },
      {
        id: "execa-export-recovery",
        passed: true,
        recoveredStatus: "success",
      },
      {
        id: "execa-export-discovery",
        passed: true,
        matches: expect.arrayContaining(["ExecaError"]),
      },
    ],
  });
});
