import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import { replay } from "../helpers/acquisition-fixture.ts";
import { captureReceiptSchema } from "../helpers/benchmark-artifact.ts";
import { installCodexFixture } from "../helpers/codex-fixture.ts";

export const registerAcquisitionCaptureTests =
  function registerAcquisitionCaptureTests(): void {
    test("captures tool responses while the server is running instead of timestamping them after the final answer", async () => {
      const directory = await mkdtemp(
        nodePath.join(tmpdir(), "codex-capture-")
      );

      const output = nodePath.join(directory, "captured");

      try {
        const bin = nodePath.join(directory, "bin");
        await mkdir(bin);
        await installCodexFixture(bin);
        const launchPath = nodePath.join(directory, "launch.json");
        await writeFile(
          launchPath,
          JSON.stringify({
            configArguments: [],
            effort: "low",
            model: "gpt-5.6-luna",
            prompt: "fixture",
            timeoutMilliseconds: 5000,
            workspace: directory,
          })
        );

        await runCommand(
          process.execPath,
          [
            "benchmarks/codex-discovery/capture.ts",
            "--launch",
            launchPath,
            "--output",
            output,
          ],
          {
            env: { PATH: `${bin}:${process.env["PATH"]}` },
          }
        );

        const captured = decodeJson(
          captureReceiptSchema,
          await readFile(nodePath.join(output, "capture.json"), "utf-8")
        );

        const readFileResult = await readFile(
          nodePath.join(output, "events.timed.jsonl"),
          "utf-8"
        );

        const events = readFileResult
          .trim()
          .split("\n")
          .map((line) => decodeJson(Schema.MutableJson, line));

        const result = await replay(events);
        expect([
          result.status,
          requireDefined(result.retrievalSeconds) > 0,
          requireDefined(result.sufficientEvidenceMilliseconds) <
            requireDefined(captured.turnCompletedMilliseconds) - 100,
          captured.answer,
        ]).toStrictEqual(["complete", true, true, "A late final answer"]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("rejects overflowing numeric JSON-RPC IDs before waiting for a response", async () => {
      const directory = await mkdtemp(
        nodePath.join(tmpdir(), "codex-capture-overflow-")
      );

      const output = nodePath.join(directory, "captured");

      try {
        const bin = nodePath.join(directory, "bin");
        await mkdir(bin);
        await installCodexFixture(bin);
        const launchPath = nodePath.join(directory, "launch.json");
        await writeFile(
          launchPath,
          JSON.stringify({
            configArguments: [],
            effort: "low",
            model: "gpt-5.6-luna",
            prompt: "fixture",
            timeoutMilliseconds: 5000,
            workspace: directory,
          })
        );

        const result = await runCommand(
          process.execPath,
          [
            "benchmarks/codex-discovery/capture.ts",
            "--launch",
            launchPath,
            "--output",
            output,
          ],
          {
            env: {
              CODEX_FIXTURE_NONFINITE_ID: "1",
              PATH: `${bin}:${process.env["PATH"]}`,
            },
            reject: false,
          }
        );

        const captured = decodeJson(
          captureReceiptSchema,
          await readFile(nodePath.join(output, "capture.json"), "utf-8")
        );

        expect([
          result.exitCode,
          captured.failureKind,
          captured.timedOut,
          captured.error,
        ]).toStrictEqual([1, "protocol", false, "Expected JSON value"]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  };
