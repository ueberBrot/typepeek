import { execa } from "execa";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { inspectWithCompiler } from "../discovery/compiler.ts";
import {
  discoveryIdentity,
  evidenceFingerprint,
  hashText,
  requirePackagedArtifact,
} from "../discovery/identity.ts";
import {
  comparePairedTimings,
  seededRandom,
  shuffled,
  summarizeTimings,
} from "../discovery/statistics.ts";
import { createCodexFixture, createCodexTrial, verifyCodexIsolation } from "./fixture.ts";
import {
  ANSWER_JSON_SCHEMA,
  type CodexCondition,
  codexPrompt,
  codexTelemetry,
  gradeCodexAnswer,
  gradeCodexExecution,
  selectCodexScenarios,
} from "./scenarios.ts";

const options = readOptions();
requirePackagedArtifact();
const scenarios = selectCodexScenarios(options.cases);
const version = (await execa("codex", ["--version"])).stdout.trim();
const skill = await readFile("skills/typepeek/SKILL.md", "utf8");
const reference = inspectWithCompiler(resolve("."), scenarios[0]!.workload);
const identity = {
  ...(await discoveryIdentity({
    workspace: resolve("."),
    adapter: "package",
    compilerVersion: reference.compilerVersion,
    evidenceHash: evidenceFingerprint(resolve("."), reference.files),
  })),
  codexHarnessHash: hashText(
    (
      await Promise.all(
        ["run.ts", "fixture.ts", "scenarios.ts"].map((file) =>
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

interface CodexAttempt {
  readonly classification: "task" | "infrastructure";
  readonly task: string;
  readonly model: string;
  readonly effort: string;
  readonly condition: CodexCondition;
  readonly repeat: number;
  readonly seconds: number;
  readonly passed: boolean;
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly promptHash: string;
  readonly evidenceHash: string;
  readonly expectedFacts: readonly string[];
  readonly telemetry: ReturnType<typeof codexTelemetry>;
  readonly artifactDirectory: string;
}

async function runStudy(): Promise<void> {
  // Verify both capability sets before any model request. A prompt alone is not isolation.
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
  const plans = options.models.flatMap((model) =>
    options.efforts.flatMap((effort) =>
      scenarios.flatMap((scenario) =>
        Array.from({ length: options.repeats }, (_, repeat) => ({
          model,
          effort,
          scenario,
          repeat,
        })),
      ),
    ),
  );
  const random = seededRandom(options.seed);
  for (const plan of shuffled(plans, random)) {
    // Conditions stay adjacent as a pair, with reproducibly randomized order.
    for (const condition of shuffled(options.conditions, random)) {
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
    }
  }
  await saveSummary("complete");
  if (attempts.some((attempt) => !attempt.passed)) process.exitCode = 1;
}

async function saveSummary(status: string): Promise<void> {
  const makeGroups = (task?: string) =>
    options.models.flatMap((model) =>
      options.efforts.flatMap((effort) =>
        options.conditions.map((condition) => {
          const recorded = attempts.filter(
            (attempt) =>
              attempt.model === model &&
              attempt.effort === effort &&
              attempt.condition === condition &&
              (task === undefined || attempt.task === task),
          );
          const selected = recorded.filter((attempt) => attempt.classification === "task");
          const successes = selected.filter((attempt) => attempt.passed);
          const completeUsage =
            recorded.length > 0 &&
            recorded.every(
              (attempt) =>
                attempt.telemetry.inputTokens !== null && attempt.telemetry.outputTokens !== null,
            );
          const sum = (field: "inputTokens" | "outputTokens" | "cachedInputTokens") =>
            recorded.reduce((total, attempt) => total + (attempt.telemetry[field] ?? 0), 0);
          const input = sum("inputTokens");
          const output = sum("outputTokens");
          const paired = successes.flatMap((attempt) => {
            const baseline = attempts.find(
              (candidate) =>
                candidate.model === model &&
                candidate.effort === effort &&
                candidate.condition === "files" &&
                candidate.task === attempt.task &&
                candidate.repeat === attempt.repeat &&
                candidate.passed,
            );
            return condition !== "files" && baseline !== undefined
              ? [{ baseline, treatment: attempt }]
              : [];
          });
          return {
            model,
            effort,
            condition,
            infrastructureFailures: recorded.length - selected.length,
            intervalScope:
              "Descriptive run-level variability within these fixed tasks; not uncertainty across tasks or packages.",
            attempts: selected.length,
            correct: successes.length,
            successRate: selected.length === 0 ? null : successes.length / selected.length,
            successByDeadline: Object.fromEntries(
              [30, 60, 120].map((deadline) => [
                deadline,
                selected.length === 0
                  ? null
                  : successes.filter((attempt) => attempt.seconds <= deadline).length /
                    selected.length,
              ]),
            ),
            successfulSeconds:
              successes.length === 0
                ? null
                : summarizeTimings(successes.map((attempt) => attempt.seconds)),
            allAttemptSeconds:
              selected.length === 0
                ? null
                : summarizeTimings(selected.map((attempt) => attempt.seconds)),
            reportedInputTokens: input,
            reportedCachedInputTokens: sum("cachedInputTokens"),
            reportedOutputTokens: output,
            reportedReasoningOutputTokens:
              recorded.every((attempt) => attempt.telemetry.reasoningOutputTokens !== null) &&
              recorded.length > 0
                ? recorded.reduce(
                    (total, attempt) => total + (attempt.telemetry.reasoningOutputTokens ?? 0),
                    0,
                  )
                : null,
            usageComplete: completeUsage,
            tokensPerCorrectAnswer:
              completeUsage && successes.length > 0 ? (input + output) / successes.length : null,
            cliAdoptionRate:
              selected.length === 0
                ? null
                : selected.filter((attempt) => attempt.telemetry.usedTypepeek).length /
                  selected.length,
            pairedSuccessfulCases: paired.length,
            pairedTimeComparison:
              paired.length === 0
                ? null
                : compareMeasurements(
                    paired.map(({ baseline }) => baseline.seconds),
                    paired.map(({ treatment }) => treatment.seconds),
                    options.seed,
                    "seconds",
                  ),
            pairedTokenComparison:
              paired.length === 0 ||
              paired.some(
                ({ baseline, treatment }) =>
                  baseline.telemetry.inputTokens === null ||
                  baseline.telemetry.outputTokens === null ||
                  treatment.telemetry.inputTokens === null ||
                  treatment.telemetry.outputTokens === null,
              )
                ? null
                : compareMeasurements(
                    paired.map(
                      ({ baseline }) =>
                        baseline.telemetry.inputTokens! + baseline.telemetry.outputTokens!,
                    ),
                    paired.map(
                      ({ treatment }) =>
                        treatment.telemetry.inputTokens! + treatment.telemetry.outputTokens!,
                    ),
                    options.seed,
                    "tokens",
                  ),
          };
        }),
      ),
    );
  const groups = makeGroups();
  const byTask = scenarios.flatMap((scenario) =>
    makeGroups(scenario.workload.id).map((group) => ({
      ...group,
      task: scenario.workload.id,
      specifier: scenario.workload.specifier,
    })),
  );
  await writeFile(
    join(options.output, "summary.json"),
    JSON.stringify(
      {
        kind: "codex-discovery-benchmark",
        schemaVersion: 1,
        status,
        codexVersion: version,
        identity,
        recordedAt: new Date().toISOString(),
        options,
        groups,
        byTask,
        attempts,
      },
      null,
      2,
    ),
  );
  const table = [
    "Codex installed-dependency discovery: verified final answers by tool-use condition",
    "Model | Effort | Tools | Correct / attempts | Successful mean seconds ± 95% CI | Reported input | Cached input | Output | Tokens per correct answer",
    "--- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...groups.map((group) =>
      [
        group.model,
        group.effort,
        group.condition,
        `${group.correct}/${group.attempts}`,
        group.successfulSeconds === null
          ? "n/a"
          : `${group.successfulSeconds.mean.toFixed(1)} ± ${group.successfulSeconds.meanCi95HalfWidth?.toFixed(1) ?? "n/a"}`,
        group.reportedInputTokens,
        group.reportedCachedInputTokens,
        group.reportedOutputTokens,
        group.tokensPerCorrectAnswer?.toFixed(0) ?? "unknown/no successes",
      ].join(" | "),
    ),
    "",
    "Token totals include every recorded attempt, including failures. Unknown usage is not counted as zero-cost success.",
    "Infrastructure failures are excluded from task-quality denominators; their known tokens remain in totals. See summary.json for their counts.",
    "Intervals describe run-level variability for these fixed tasks, not uncertainty across tasks or packages. A recorded command is required, but evidence use needs trace review.",
    "Reasoning tokens, when reported, are a breakdown of output; they are not added twice. Subscription billing is not inferred from token counts.",
    "",
    "Task | Model / effort | Tools | Correct / attempts | Mean successful seconds | Tokens per correct answer",
    "--- | --- | --- | --- | --- | ---",
    ...byTask.map((group) =>
      [
        group.task,
        `${group.model}/${group.effort}`,
        group.condition,
        `${group.correct}/${group.attempts}`,
        group.successfulSeconds?.mean.toFixed(1) ?? "n/a",
        group.tokensPerCorrectAnswer?.toFixed(0) ?? "unknown/no successes",
      ].join(" | "),
    ),
  ].join("\n");
  await writeFile(join(options.output, "summary.md"), `${table}\n`);
  if (status !== "running") process.stdout.write(`${table}\nStatus: ${status}\n`);
}

function compareMeasurements(
  baseline: readonly number[],
  treatment: readonly number[],
  seed: number,
  unit: "seconds" | "tokens",
) {
  const comparison = comparePairedTimings(baseline, treatment, seed);
  return {
    unit,
    medianRatio: comparison.medianSpeedup,
    ratioCi95: comparison.speedupCi95,
    medianSaved: comparison.medianSavedMilliseconds,
  };
}

function readOptions() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: node benchmarks/codex-discovery/run.ts [options]
  --cases IDS               Comma-separated workload IDs or all (default: five-package suite)
  --models IDS              Codex model IDs (default: gpt-5.6-luna)
  --efforts LEVELS          low,medium,high (default: low)
  --conditions VALUES       files,typepeek,typepeek-skill,typepeek-required (default: files,typepeek)
  --repeats N               Fresh trials per task/model/effort/condition (default: 3)
  --deadline-seconds N      Hard per-trial deadline (default: 120)
  --trial-token-limit N     Codex rollout budget per trial (default: 60000)
  --total-token-limit N     Stop launching trials after reported cumulative usage (default: 2000000)
  --seed N                  Reproducible pairing/order seed (default: 1729)
  --output DIRECTORY        Empty directory for trial artifacts (default: timestamped .benchmarks/codex-discovery subdirectory)
  --prepare-only            Verify isolation without making model requests

Requires a built dist/, installed dependencies, ripgrep, and authenticated Codex CLI with permission profiles.
The fixtures and grading are deterministic; live Codex time and token usage are statistical observations.
`);
    process.exit(0);
  }
  if (process.platform === "win32")
    throw new Error("This runner currently requires macOS or Linux sandbox enforcement.");
  const { values } = parseArgs({
    options: {
      cases: {
        type: "string",
        default: "execa-command,node-exists,effect-option,stricli-routes,typescript-program",
      },
      models: { type: "string", default: "gpt-5.6-luna" },
      efforts: { type: "string", default: "low" },
      conditions: { type: "string", default: "files,typepeek" },
      repeats: { type: "string", default: "3" },
      "deadline-seconds": { type: "string", default: "120" },
      "trial-token-limit": { type: "string", default: "60000" },
      "total-token-limit": { type: "string", default: "2000000" },
      seed: { type: "string", default: "1729" },
      output: {
        type: "string",
        default: `.benchmarks/codex-discovery/${new Date().toISOString().replaceAll(":", "-")}`,
      },
      "prepare-only": { type: "boolean", default: false },
    },
  });
  const list = (value: string) => {
    const items = value.split(",").map((item) => item.trim());
    if (items.some((item) => item === "") || new Set(items).size !== items.length)
      throw new Error("Lists must be nonempty and unique.");
    return items;
  };
  const number = (value: string, minimum: number, maximum: number) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
      throw new Error(`Expected integer between ${minimum} and ${maximum}.`);
    return parsed;
  };
  const efforts = list(values.efforts);
  if (efforts.some((effort) => !["low", "medium", "high"].includes(effort)))
    throw new Error("Use the common low, medium, or high effort levels.");
  const conditions = list(values.conditions);
  if (
    conditions.some(
      (condition) =>
        !["files", "typepeek", "typepeek-skill", "typepeek-required"].includes(condition),
    )
  )
    throw new Error("Unknown condition.");
  return {
    cases: list(values.cases),
    models: list(values.models),
    efforts,
    conditions: conditions as CodexCondition[],
    repeats: number(values.repeats, 1, 20),
    deadlineSeconds: number(values["deadline-seconds"], 10, 600),
    trialTokenLimit: number(values["trial-token-limit"], 1000, 1_000_000),
    totalTokenLimit: number(values["total-token-limit"], 1000, 10_000_000),
    seed: number(values.seed, 0, 4_294_967_295),
    output: resolve(values.output),
    prepareOnly: values["prepare-only"],
  };
}
