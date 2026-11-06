import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

import { requireDefined } from "#typepeek/defined-value";
import { runCommand } from "#typepeek/process-command";

import { inspectWithCompiler } from "../support/compiler.ts";
import {
  discoveryIdentity,
  evidenceFingerprint,
  hashText,
  requirePackagedArtifact,
} from "../support/identity.ts";
import type { AcquisitionOracle } from "./acquisition-evidence.ts";
import { measureAcquisition } from "./acquisition.ts";
import { captureCodex } from "./capture.ts";
import {
  createCodexFixture,
  createCodexTrial,
  verifyCodexIsolation,
} from "./fixture.ts";
import { readCodexOptions, scheduleCodexTrials } from "./options.ts";
import type { CodexAttempt } from "./report.ts";
import { summarizeCodexStudy } from "./report.ts";
import {
  ANSWER_JSON_SCHEMA,
  codexPrompt,
  gradeCodexAnswer,
  gradeCodexExecution,
  selectCodexScenarios,
} from "./scenarios.ts";
import { measureTaskTiming } from "./task-timing.ts";
import { codexTelemetry } from "./telemetry.ts";

const options = readCodexOptions();
const scenarios = selectCodexScenarios(options.cases);
const fullSchedule = scheduleCodexTrials(options, scenarios);

if (options.startAt >= fullSchedule.length) {
  throw new Error("start-at must be within the schedule.");
}

const schedule = fullSchedule.slice(options.startAt);

if (options.dryRun) {
  process.stdout.write(
    `${JSON.stringify(
      {
        trials: schedule.map(({ scenario, ...trial }) => ({
          ...trial,
          task: scenario.workload.id,
        })),
      },
      null,
      2
    )}\n`
  );
  process.exit(0);
}

requirePackagedArtifact();

const codexVersionResult = await runCommand("codex", ["--version"]);
const version = codexVersionResult.stdout.trim();
const skill = await readFile("skills/typepeek/SKILL.md", "utf-8");

const reference = inspectWithCompiler(
  nodePath.resolve("."),
  requireDefined(scenarios[0]).workload
);

const harnessFiles = await Promise.all(
  [
    "run.ts",
    "fixture.ts",
    "scenarios.ts",
    "telemetry.ts",
    "options.ts",
    "report.ts",
    "acquisition.ts",
    "acquisition-evidence.ts",
    "capture.ts",
    "exchange.ts",
    "replay.ts",
    "comparison-matrix.ts",
    "task-timing.ts",
  ].map(
    async (file) =>
      await readFile(nodePath.join("benchmarks/codex-discovery", file), "utf-8")
  )
);

const identity = {
  ...(await discoveryIdentity({
    compilerVersion: reference.compilerVersion,
    evidenceHash: evidenceFingerprint(nodePath.resolve("."), reference.files),
    workspace: nodePath.resolve("."),
  })),
  codexHarnessHash: hashText(harnessFiles.join("\0")),
  skillHash: hashText(skill),
};

await mkdir(options.output, { recursive: true });

const outputEntries = await readdir(options.output);

if (outputEntries.length > 0) {
  throw new Error(
    "Use an empty output directory to preserve every study's artifacts."
  );
}

const fixture = await createCodexFixture();
const attempts: CodexAttempt[] = [];

const saveSummary = async function saveSummary(status: string): Promise<void> {
  const { data, markdown } = summarizeCodexStudy({
    attempts,
    identity,
    options,
    scenarios,
    status,
    version,
  });

  await writeFile(
    nodePath.join(options.output, "summary.json"),
    JSON.stringify(data, null, 2)
  );
  await writeFile(nodePath.join(options.output, "summary.md"), markdown);

  if (status !== "running") {
    process.stdout.write(`${markdown}Status: ${status}\n`);
  }
};

const classifyAttempt = (
  result: Awaited<ReturnType<typeof captureCodex>>,
  telemetry: ReturnType<typeof codexTelemetry>
): CodexAttempt["classification"] => {
  if (result.error === null || result.timedOut) {
    return "task";
  }

  if (telemetry.completedTurns !== 0 || telemetry.commands.length !== 0) {
    return "task";
  }

  return telemetry.inputTokens === null && telemetry.outputTokens === null
    ? "infrastructure"
    : "task";
};

const runStudy = async function runStudy(): Promise<void> {
  await Array.fromAsync(options.conditions, async (condition) => {
    const trial = await createCodexTrial(
      fixture,
      `preflight-${condition}`,
      condition
    );

    await verifyCodexIsolation(fixture, trial, condition);
  });

  process.stderr.write(
    `Verified Codex ${version}: fixture readable, helpers writable, dependencies read-only, grader hidden, CLI available only in treatment.\n`
  );

  if (options.prepareOnly) {
    process.stdout.write(
      "Isolation preflight passed. No model requests were made.\n"
    );

    return;
  }

  // Trials share one fixture and each completed trial determines the remaining token budget.
  /* oxlint-disable eslint/no-await-in-loop -- Trial isolation and budget accounting require serial execution. */
  for (const plan of schedule) {
    const { condition } = plan;

    const accounted = attempts.reduce(
      (sum, attempt) =>
        sum +
        (attempt.telemetry.inputTokens ?? 0) +
        (attempt.telemetry.outputTokens ?? 0),
      0
    );

    if (
      options.totalTokenLimit !== null &&
      accounted >= options.totalTokenLimit
    ) {
      process.stderr.write(
        "Campaign token limit reached; remaining trials were not started.\n"
      );
      await saveSummary("token-limit");
      process.exitCode = 1;

      return;
    }

    const id = `${String(options.startAt + attempts.length).padStart(3, "0")}-${plan.scenario.workload.id}-${condition}`;
    const directory = nodePath.join(options.output, id);
    await mkdir(directory, { recursive: true });
    const trial = await createCodexTrial(fixture, id, condition);
    const oracle = inspectWithCompiler(trial.workspace, plan.scenario.workload);
    const evidenceHash = evidenceFingerprint(trial.workspace, oracle.files);
    const prompt = codexPrompt(plan.scenario, condition, skill);
    const schemaPath = nodePath.join(directory, "answer.schema.json");
    const answerPath = nodePath.join(directory, "answer.json");
    await writeFile(schemaPath, JSON.stringify(ANSWER_JSON_SCHEMA));
    await writeFile(nodePath.join(directory, "prompt.txt"), prompt);

    const configArguments = [
      "-c",
      "features.rollout_budget.enabled=true",
      "-c",
      `features.rollout_budget.limit_tokens=${options.trialTokenLimit}`,
      "-c",
      `features.rollout_budget.reminder_at_remaining_tokens=[${Math.floor(options.trialTokenLimit / 4)}]`,
      ...trial.configArguments,
    ];

    const acquisitionOracle: AcquisitionOracle = {
      declarations: oracle.declarations,
      exportDeclarations: oracle.exportDeclarations,
      facts: oracle.facts,
      schemaVersion: 1,
      workload: plan.scenario.workload,
    };

    await writeFile(
      nodePath.join(directory, "oracle.json"),
      JSON.stringify(acquisitionOracle, null, 2)
    );

    if (plan.effort !== "low" && plan.effort !== "high") {
      throw new Error("Unsupported reasoning effort.");
    }

    const launch: Parameters<typeof captureCodex>[0] = {
      codexHome: fixture.codexHome,
      configArguments,
      effort: plan.effort,
      model: plan.model,
      outputSchema: ANSWER_JSON_SCHEMA,
      prompt,
      timeoutMilliseconds: options.deadlineSeconds * 1000,
      workspace: trial.workspace,
    };

    await writeFile(
      nodePath.join(directory, "launch.json"),
      JSON.stringify(
        {
          ...launch,
          condition,
          deadlineSeconds: options.deadlineSeconds,
          effort: plan.effort,
          evidenceHash,
          model: plan.model,
          promptHash: hashText(prompt),
          trialTokenLimit: options.trialTokenLimit,
        },
        null,
        2
      )
    );
    process.stderr.write(
      `Running ${plan.model}/${plan.effort} ${plan.scenario.workload.id} ${condition}, repeat ${plan.repeat + 1}.\n`
    );
    const result = await captureCodex(launch);
    const seconds = result.processSeconds;
    const serializedEvents = `${result.events.map(({ event }) => JSON.stringify(event)).join("\n")}\n`;
    await writeFile(nodePath.join(directory, "events.jsonl"), serializedEvents);
    await writeFile(
      nodePath.join(directory, "events.timed.jsonl"),
      `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`
    );
    await writeFile(nodePath.join(directory, "stderr.txt"), result.stderr);
    const telemetry = codexTelemetry(serializedEvents);
    await writeFile(answerPath, result.answer);
    const grade = gradeCodexAnswer(plan.scenario, oracle.facts, result.answer);
    const acquisition = measureAcquisition(acquisitionOracle, result.events);
    await writeFile(
      nodePath.join(directory, "acquisition.json"),
      `${JSON.stringify(acquisition, null, 2)}\n`
    );

    const evidenceUnchanged =
      evidenceFingerprint(trial.workspace, oracle.files) === evidenceHash;

    const readError = () => {
      if (
        result.failureKind === "protocol" ||
        (acquisition.status !== "complete" && result.error !== null)
      ) {
        return result.error;
      }

      if (evidenceUnchanged) {
        return (
          gradeCodexExecution(plan.scenario, condition, telemetry, false) ??
          (acquisition.status === "complete"
            ? null
            : "Required evidence was not retrieved.")
        );
      }

      return "Installed evidence changed during the trial.";
    };

    const error = readError();

    const attempt: CodexAttempt = {
      acquisition,
      artifactDirectory: directory,
      classification: classifyAttempt(result, telemetry),
      condition,
      effort: plan.effort,
      error,
      evidenceHash,
      exitCode: result.exitCode ?? null,
      expectedFacts: oracle.facts,
      finalAnswer: grade,
      instructionTokens: {
        prompt: countTokens(prompt),
        scope:
          "Prompt includes skill; excludes provider system instructions and tool schemas.",
        skill:
          condition === "typepeek-skill" || condition === "typepeek-required"
            ? countTokens(skill)
            : 0,
      },
      model: plan.model,
      passed: error === null && acquisition.status === "complete",
      promptHash: hashText(prompt),
      repeat: plan.repeat,
      seconds,
      task: plan.scenario.workload.id,
      telemetry,
      timedOut: result.timedOut,
      timing: measureTaskTiming(result.events),
      wholeRunError: result.error,
    };

    attempts.push(attempt);
    await writeFile(
      nodePath.join(directory, "result.json"),
      JSON.stringify(attempt, null, 2)
    );
    await saveSummary("running");
    process.stderr.write(
      `  ${attempt.passed ? "evidence complete" : "FAILED"}: acquisition ${acquisition.taskToEvidenceSeconds?.toFixed(3) ?? "unknown"} s, ${acquisition.evidenceTokens} evidence tokens; whole run ${seconds.toFixed(1)} s, input ${telemetry.inputTokens ?? "unknown"}, output ${telemetry.outputTokens ?? "unknown"}, ${telemetry.commands.length} commands.\n`
    );

    if (attempt.classification === "infrastructure") {
      await saveSummary("infrastructure-failure");
      process.exitCode = 1;

      return;
    }

    if (!telemetry.usageComplete) {
      await saveSummary("usage-incomplete");
      process.exitCode = 1;

      return;
    }
  }

  /* oxlint-enable eslint/no-await-in-loop */
  await saveSummary("complete");

  if (attempts.some((attempt) => !attempt.passed)) {
    process.exitCode = 1;
  }
};

try {
  await runStudy();
} finally {
  await fixture.cleanup();
}
