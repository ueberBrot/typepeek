import { execa } from "execa";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { inspectWithCompiler } from "../discovery/compiler.ts";
import {
  discoveryIdentity,
  evidenceFingerprint,
  hashText,
  requirePackagedArtifact,
} from "../discovery/identity.ts";
import { createCodexFixture, createCodexTrial, verifyCodexIsolation } from "./fixture.ts";
import { readCodexOptions, scheduleCodexTrials } from "./options.ts";
import { type CodexAttempt, summarizeCodexStudy } from "./report.ts";
import {
  ANSWER_JSON_SCHEMA,
  codexPrompt,
  codexTelemetry,
  gradeCodexAnswer,
  gradeCodexExecution,
  selectCodexScenarios,
} from "./scenarios.ts";

const options = readCodexOptions();
const scenarios = selectCodexScenarios(options.cases);
const schedule = scheduleCodexTrials(options, scenarios);
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
      2,
    )}\n`,
  );
  process.exit(0);
}
requirePackagedArtifact();
const version = (await execa("codex", ["--version"])).stdout.trim();
const skill = await readFile("skills/typepeek/SKILL.md", "utf8");
const reference = inspectWithCompiler(resolve("."), scenarios[0]!.workload);
const identity = {
  ...(await discoveryIdentity({
    workspace: resolve("."),
    compilerVersion: reference.compilerVersion,
    evidenceHash: evidenceFingerprint(resolve("."), reference.files),
  })),
  codexHarnessHash: hashText(
    (
      await Promise.all(
        ["run.ts", "fixture.ts", "scenarios.ts", "options.ts", "report.ts"].map((file) =>
          readFile(join("benchmarks/codex-discovery", file), "utf8"),
        ),
      )
    ).join("\0"),
  ),
  skillHash: hashText(skill),
};
await mkdir(options.output, { recursive: true });
if ((await readdir(options.output)).length > 0) {
  throw new Error("Use an empty output directory to preserve every study's artifacts.");
}
const fixture = await createCodexFixture();
const attempts: CodexAttempt[] = [];
try {
  await runStudy();
} finally {
  await fixture.cleanup();
}

async function runStudy(): Promise<void> {
  for (const condition of options.conditions) {
    const trial = await createCodexTrial(fixture, `preflight-${condition}`, condition);
    await verifyCodexIsolation(fixture, trial, condition);
  }
  process.stderr.write(
    `Verified Codex ${version}: fixture readable, helpers writable, dependencies read-only, grader hidden, CLI available only in treatment.\n`,
  );
  if (options.prepareOnly) {
    process.stdout.write("Isolation preflight passed. No model requests were made.\n");
    return;
  }
  for (const plan of schedule) {
    const { condition } = plan;
    const accounted = attempts.reduce(
      (sum, attempt) =>
        sum + (attempt.telemetry.inputTokens ?? 0) + (attempt.telemetry.outputTokens ?? 0),
      0,
    );
    if (accounted >= options.totalTokenLimit) {
      process.stderr.write("Campaign token limit reached; remaining trials were not started.\n");
      await saveSummary("token-limit");
      process.exitCode = 1;
      return;
    }
    const id = `${String(attempts.length).padStart(3, "0")}-${plan.scenario.workload.id}-${condition}`;
    const directory = join(options.output, id);
    await mkdir(directory, { recursive: true });
    const trial = await createCodexTrial(fixture, id, condition);
    const oracle = inspectWithCompiler(trial.workspace, plan.scenario.workload);
    const evidenceHash = evidenceFingerprint(trial.workspace, oracle.files);
    const prompt = codexPrompt(plan.scenario, condition, skill);
    const schemaPath = join(directory, "answer.schema.json");
    const answerPath = join(directory, "answer.json");
    await writeFile(schemaPath, JSON.stringify(ANSWER_JSON_SCHEMA));
    await writeFile(join(directory, "prompt.txt"), prompt);
    const arguments_ = [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      "--color",
      "never",
      "--cd",
      trial.workspace,
      "--model",
      plan.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(plan.effort)}`,
      "-c",
      "features.rollout_budget.enabled=true",
      "-c",
      `features.rollout_budget.limit_tokens=${options.trialTokenLimit}`,
      "-c",
      `features.rollout_budget.reminder_at_remaining_tokens=[${Math.floor(options.trialTokenLimit / 4)}]`,
      ...trial.configArguments,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      answerPath,
      "-",
    ];
    await writeFile(
      join(directory, "launch.json"),
      JSON.stringify(
        {
          command: "codex",
          arguments: arguments_,
          model: plan.model,
          effort: plan.effort,
          condition,
          deadlineSeconds: options.deadlineSeconds,
          trialTokenLimit: options.trialTokenLimit,
          promptHash: hashText(prompt),
          evidenceHash,
        },
        null,
        2,
      ),
    );
    process.stderr.write(
      `Running ${plan.model}/${plan.effort} ${plan.scenario.workload.id} ${condition}, repeat ${plan.repeat + 1}.\n`,
    );
    const started = performance.now();
    const result = await execa("codex", arguments_, {
      input: prompt,
      reject: false,
      timeout: options.deadlineSeconds * 1000,
      forceKillAfterDelay: 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const seconds = (performance.now() - started) / 1000;
    await writeFile(join(directory, "events.jsonl"), result.stdout);
    await writeFile(join(directory, "stderr.txt"), result.stderr);
    const telemetry = codexTelemetry(result.stdout);
    const answer = await readFile(answerPath, "utf8").catch(() => "");
    const grade = gradeCodexAnswer(plan.scenario, oracle.facts, answer);
    const evidenceUnchanged = evidenceFingerprint(trial.workspace, oracle.files) === evidenceHash;
    const error = result.failed
      ? (result.shortMessage ?? "Codex process failed.")
      : !evidenceUnchanged
        ? "Installed evidence changed during the trial."
        : (gradeCodexExecution(plan.scenario, condition, telemetry) ?? grade.error);
    const attempt: CodexAttempt = {
      classification:
        result.failed &&
        !result.timedOut &&
        telemetry.completedTurns === 0 &&
        telemetry.commands.length === 0
          ? "infrastructure"
          : "task",
      task: plan.scenario.workload.id,
      model: plan.model,
      effort: plan.effort,
      condition,
      repeat: plan.repeat,
      seconds,
      passed: error === null && grade.passed,
      error,
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut,
      promptHash: hashText(prompt),
      evidenceHash,
      expectedFacts: oracle.facts,
      telemetry,
      artifactDirectory: directory,
    };
    attempts.push(attempt);
    await writeFile(join(directory, "result.json"), JSON.stringify(attempt, null, 2));
    await saveSummary("running");
    process.stderr.write(
      `  ${attempt.passed ? "correct" : "FAILED"}: ${seconds.toFixed(1)} s, input ${telemetry.inputTokens ?? "unknown"}, output ${telemetry.outputTokens ?? "unknown"}, ${telemetry.commands.length} commands.\n`,
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
  await saveSummary("complete");
  if (attempts.some((attempt) => !attempt.passed)) process.exitCode = 1;
}

async function saveSummary(status: string): Promise<void> {
  const { data, markdown } = summarizeCodexStudy({
    status,
    options,
    scenarios,
    attempts,
    version,
    identity,
  });
  await writeFile(join(options.output, "summary.json"), JSON.stringify(data, null, 2));
  await writeFile(join(options.output, "summary.md"), markdown);
  if (status !== "running") process.stdout.write(`${markdown}Status: ${status}\n`);
}
