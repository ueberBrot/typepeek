import { inspectWithCompiler } from "./compiler.ts";
import { selectDiscoveryWorkloads } from "./workloads.ts";

const [workspace, workloadId] = process.argv.slice(2);
if (workspace === undefined || workloadId === undefined) {
  throw new TypeError("Expected workspace and workload ID.");
}
const workload = selectDiscoveryWorkloads(workloadId)[0];
if (workload === undefined) {
  throw new TypeError("Missing workload.");
}
const { facts, compilerVersion } = inspectWithCompiler(workspace, workload);
process.stdout.write(`${JSON.stringify({ facts, files: [], compilerVersion })}\n`);
