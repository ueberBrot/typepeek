import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { runCommand } from "#typepeek/platform/process-command";

import { inspectWithCompiler } from "../benchmarks/support/compiler.ts";
import { typepeekFacts } from "../benchmarks/support/evidence.ts";
import {
  evidenceFingerprint,
  requirePackagedArtifact,
} from "../benchmarks/support/identity.ts";
import {
  discoveryCliArguments,
  selectDiscoveryWorkloads,
} from "../benchmarks/support/workloads.ts";

const cli = requirePackagedArtifact();
const workspace = nodePath.resolve(".");

const cache = await mkdtemp(
  nodePath.join(tmpdir(), "typepeek-benchmark-correctness-")
);

const workloads = selectDiscoveryWorkloads();

assert.equal(workloads.length, 10);

try {
  await Array.fromAsync(workloads, async (workload) => {
    const oracle = inspectWithCompiler(workspace, workload);
    const before = evidenceFingerprint(workspace, oracle.files);

    if (workload.id === "semver-clean") {
      assert.deepEqual(oracle.facts, [
        "call:( version : string , optionsOrLoose ? : boolean | semver . Options ) : string | null",
      ]);
    }

    await Array.fromAsync(["1", "0", "0"], async (bypass) => {
      const result = await runCommand(
        process.execPath,
        [cli, ...discoveryCliArguments(workload)],
        {
          env: {
            TYPEPEEK_CACHE_BYPASS: bypass,
            TYPEPEEK_CACHE_DIRECTORY: cache,
            TYPEPEEK_PROFILE: "0",
          },
        }
      );

      assert.deepEqual(
        typepeekFacts(workload, result.stdout),
        oracle.facts,
        workload.id
      );
    });

    assert.equal(
      evidenceFingerprint(workspace, oracle.files),
      before,
      workload.id
    );
  });
} finally {
  await rm(cache, { force: true, recursive: true });
}

console.log(
  "Packaged benchmark correctness passed: all ten workloads match the independent oracle with cache bypassed and enabled."
);
