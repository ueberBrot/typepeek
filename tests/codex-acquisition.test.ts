import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { runCommand } from "#typepeek/process-command";

import { registerAcquisitionCampaignTests } from "./codex-acquisition/campaign.test.suite.ts";
import { registerAcquisitionCaptureTests } from "./codex-acquisition/capture.test.suite.ts";
import { registerAcquisitionReplayTests } from "./codex-acquisition/replay.test.suite.ts";
import { command, oracle } from "./helpers/acquisition-fixture.ts";

describe("codex-acquisition", () => {
  beforeAll(async () => {
    await runCommand("vp", ["pack"]);
  }, 60_000);

  registerAcquisitionReplayTests();
  registerAcquisitionCaptureTests();
  registerAcquisitionCampaignTests();

  it("preserves an existing replay artifact instead of overwriting it", async () => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "codex-replay-preservation-")
    );

    const output = nodePath.join(directory, "acquisition.json");

    try {
      const trace = nodePath.join(directory, "events.timed.jsonl");
      const answerKey = nodePath.join(directory, "oracle.json");

      await writeFile(
        trace,
        [
          command(1000, "read"),
          command(2000, "read", requireDefined(oracle.declarations[0]).text),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n")
      );
      await writeFile(answerKey, JSON.stringify(oracle));
      await writeFile(output, "retained evidence");

      const result = await runCommand(
        process.execPath,
        [
          "benchmarks/codex-discovery/replay.ts",
          "--trace",
          trace,
          "--oracle",
          answerKey,
          "--output",
          output,
        ],
        { reject: false }
      );

      expect([result.failed, result.stderr.includes("EEXIST")]).toStrictEqual([
        true,
        true,
      ]);
      await expect(readFile(output, "utf-8")).resolves.toBe(
        "retained evidence"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
