import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { selectDiscoveryWorkloads } from "./workloads.ts";

const [workspace, workloadId] = process.argv.slice(2);
if (workspace === undefined || workloadId === undefined) {
  throw new TypeError("Expected workspace and workload ID.");
}
const workload = selectDiscoveryWorkloads(workloadId)[0];
if (workload?.filesPackage === undefined) {
  throw new TypeError("This workload has no search/read replay.");
}
const require = createRequire(join(resolve(workspace), "package.json"));
const packageName = workload.filesPackage;
const entry = require.resolve(
  packageName.startsWith("@types/") ? `${packageName}/package.json` : packageName,
);
let root = dirname(entry);
while (true) {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      manifest.name === packageName
    ) {
      break;
    }
  } catch {
    // Entry points can be below the package root.
  }
  const parent = dirname(root);
  if (parent === root) {
    throw new Error(`Cannot locate manifest for ${packageName}.`);
  }
  root = parent;
}
const arguments_ = [
  "--no-config",
  "--no-ignore",
  "--follow",
  "--files-with-matches",
  "--glob",
  "*.d.{ts,mts,cts}",
  "--regexp",
  `\\bfunction\\s+${workload.target}\\b`,
  root,
];
const paths = execFileSync("rg", arguments_, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  .trim()
  .split("\n")
  .sort();
let bytes = 0;
const files = paths.map((path) => {
  const text = readFileSync(path, "utf8");
  bytes += Buffer.byteLength(text);
  if (bytes > 4 * 1024 * 1024) {
    throw new Error("Search/read replay exceeded its 4 MiB evidence budget.");
  }
  return { path, text };
});
process.stdout.write(
  `${JSON.stringify({ files, commands: [["rg", ...arguments_], ...paths.map((path) => ["read", path])] })}\n`,
);
