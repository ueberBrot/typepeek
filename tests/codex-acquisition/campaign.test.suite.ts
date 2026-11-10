import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { requireDefined } from "#typepeek/shared/defined-value";
import { decodeJson } from "#typepeek/shared/json-data";

import { discoveryStudySchema } from "../helpers/benchmark-artifact.ts";
import { installCodexFixture } from "../helpers/codex-fixture.ts";
import { match } from "../helpers/matchers.ts";

export const registerAcquisitionCampaignTests =
  function registerAcquisitionCampaignTests(): void {
    test("grades an acquisition campaign by retrieved evidence even when the final answers are wrong", async () => {
      const directory = await mkdtemp(
        nodePath.join(tmpdir(), "codex-acquisition-study-")
      );

      const output = nodePath.join(directory, "study");

      try {
        const bin = nodePath.join(directory, "bin");
        await mkdir(bin);
        await installCodexFixture(bin);

        await runCommand(
          process.execPath,
          [
            "benchmarks/codex-discovery/run.ts",
            "--cases",
            "semver-clean",
            "--models",
            "gpt-6-luna",
            "--efforts",
            "low",
            "--repeats",
            "1",
            "--output",
            output,
          ],
          { env: { PATH: `${bin}:${process.env["PATH"]}` }, timeout: 60_000 }
        );

        const study = decodeJson(
          discoveryStudySchema,
          await readFile(nodePath.join(output, "summary.json"), "utf-8")
        );

        expect([study.schemaVersion, study.attempts.length]).toStrictEqual([
          5, 2,
        ]);

        for (const attempt of study.attempts) {
          expect([
            attempt,
            requireDefined(
              requireDefined(attempt.acquisition).retrievalSeconds
            ) < attempt.seconds,
            requireDefined(
              requireDefined(attempt.acquisition).taskToEvidenceSeconds
            ) >
              requireDefined(
                requireDefined(attempt.acquisition).retrievalSeconds
              ),
            requireDefined(attempt.acquisition).evidenceTokens > 0,
          ]).toStrictEqual([
            match.objectContaining({
              acquisition: match.objectContaining({
                missingFacts: [],
                status: "complete",
              }),
              finalAnswer: match.objectContaining({ passed: false }),
              passed: true,
            }),
            true,
            true,
            true,
          ]);

          const group = study.groups.find(
            (value: { condition: string }) =>
              value.condition === attempt.condition
          );

          expect([
            requireDefined(requireDefined(group).successfulSeconds).mean,
            requireDefined(requireDefined(group).successfulEvidenceTokens).mean,
            requireDefined(requireDefined(group).wholeRun.successfulSeconds)
              .mean,
            requireDefined(attempt.instructionTokens).prompt > 0,
            requireDefined(attempt.instructionTokens).skill,
            requireDefined(group).coverageComplete,
            requireDefined(group).precisionWithinTenPercent === null,
          ]).toStrictEqual([
            requireDefined(attempt.acquisition).taskToEvidenceSeconds,
            requireDefined(attempt.acquisition).evidenceTokens,
            attempt.seconds,
            true,
            attempt.condition === "typepeek-skill"
              ? requireDefined(
                  requireDefined(
                    study.attempts.find(
                      (value: { condition: string }) =>
                        value.condition === "typepeek-skill"
                    )
                  ).instructionTokens
                ).skill
              : 0,
            true,
            true,
          ]);
        }

        await expect(
          readFile(nodePath.join(output, "summary.md"), "utf-8")
        ).resolves.toContain("Task-to-evidence time");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }, 75_000);

    test.each([
      ["CODEX_FIXTURE_FAIL_LATE", "Late model failure", true, false],
      ["CODEX_FIXTURE_FAIL_CLEANUP", "Terminal cleanup failed", true, true],
      ["CODEX_FIXTURE_FAIL_EARLY", "Early model failure", false, false],
      [
        "CODEX_FIXTURE_CROSS_THREAD_CLEANUP",
        "Received another thread's turn.",
        false,
        false,
      ],
    ] as const)(
      "keeps task outcomes separate from whole-run failure: %s",
      async (flag, error, passed, usageComplete) => {
        const directory = await mkdtemp(
          nodePath.join(tmpdir(), "codex-late-failure-")
        );

        const output = nodePath.join(directory, "study");

        try {
          const bin = nodePath.join(directory, "bin");
          await mkdir(bin);
          await installCodexFixture(bin);

          await runCommand(
            process.execPath,
            [
              "benchmarks/codex-discovery/run.ts",
              "--cases",
              "semver-clean",
              "--models",
              "gpt-6-luna",
              "--efforts",
              "low",
              "--conditions",
              "files",
              "--repeats",
              "1",
              "--output",
              output,
            ],
            {
              env: { PATH: `${bin}:${process.env["PATH"]}`, [flag]: "1" },
              reject: false,
              timeout: 60_000,
            }
          );

          const study = decodeJson(
            discoveryStudySchema,
            await readFile(nodePath.join(output, "summary.json"), "utf-8")
          );

          expect([study.attempts[0], study.groups[0]]).toStrictEqual([
            match.objectContaining({
              classification: "task",
              passed,
              telemetry: match.objectContaining({
                inputTokens: 100,
                outputTokens: 20,
                usageComplete,
              }),
              wholeRunError: error,
            }),
            match.objectContaining({
              attempts: 1,
              evidenceComplete: passed ? 1 : 0,
              infrastructureFailures: 0,
              successRate: passed ? 1 : 0,
            }),
          ]);
        } finally {
          await rm(directory, { force: true, recursive: true });
        }
      },
      75_000
    );
  };
