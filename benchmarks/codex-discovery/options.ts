import nodePath from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { seededRandom, shuffled } from "../support/statistics.ts";
import type { CodexScenario } from "./scenarios.ts";
import { codexConditionSchema } from "./scenarios.ts";

const list = (value: string) => {
  const items = value.split(",").map((item) => item.trim());

  if (
    items.some((item) => item === "") ||
    new Set(items).size !== items.length
  ) {
    throw new Error("Lists must be nonempty and unique.");
  }

  return items;
};

const number = (value: string, minimum: number, maximum: number) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected integer between ${minimum} and ${maximum}.`);
  }

  return parsed;
};

const CODEX_MODELS = [
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-6-astra",
] as const;

const CODEX_EFFORTS = ["low", "high"] as const;

export type CodexOptions = ReturnType<typeof readCodexOptions>;

export const readCodexOptions = function readCodexOptions() {
  if (process.argv.includes("--help")) {
    process.stdout
      .write(`Usage: node benchmarks/codex-discovery/run.ts [options]
  --cases IDS               Comma-separated workload IDs or all (default: five-package suite)
  --models IDS              Codex model IDs (default: ${CODEX_MODELS.join(",")})
  --efforts LEVELS          low,high (default: both)
  --conditions VALUES       files,typepeek-skill (default); typepeek and typepeek-required are optional diagnostics
  --repeats N               Fresh trials per task/model/effort/condition (default: 3)
  --deadline-seconds N      Hard per-trial deadline (default: 120)
  --trial-token-limit N     Codex rollout budget per trial (default: 60000)
  --total-token-limit N     Stop after cumulative usage; unlimited disables the campaign cap (default: 2000000)
  --seed N                  Reproducible pairing/order seed (default: 1729)
  --start-at N              Skip N scheduled trials when continuing in a new output directory (default: 0)
  --output DIRECTORY        Empty directory for trial artifacts (default: timestamped .benchmarks/codex-discovery subdirectory)
  --prepare-only            Verify isolation without making model requests
  --dry-run                 Print the scheduled trials without accessing Codex or creating files

Requires a built dist/, installed dependencies, and authenticated Codex CLI with permission profiles.
The fixtures and grading are deterministic; live Codex time and token usage are statistical observations.
`);
    process.exit(0);
  }

  const { values } = parseArgs({
    options: {
      cases: {
        default:
          "semver-clean,node-exists,effect-option,effect-map,tsrs-filesystem",
        type: "string",
      },
      conditions: { default: "files,typepeek-skill", type: "string" },
      "deadline-seconds": { default: "120", type: "string" },
      "dry-run": { default: false, type: "boolean" },
      efforts: { default: CODEX_EFFORTS.join(","), type: "string" },
      models: { default: CODEX_MODELS.join(","), type: "string" },
      output: {
        default: `.benchmarks/codex-discovery/${new Date().toISOString().replaceAll(":", "-")}`,
        type: "string",
      },
      "prepare-only": { default: false, type: "boolean" },
      repeats: { default: "3", type: "string" },
      seed: { default: "1729", type: "string" },
      "start-at": { default: "0", type: "string" },
      "total-token-limit": { default: "2000000", type: "string" },
      "trial-token-limit": { default: "60000", type: "string" },
    },
  });

  if (process.platform === "win32" && !values["dry-run"]) {
    throw new Error("Live trials require macOS or Linux sandbox enforcement.");
  }

  const efforts = list(values.efforts);

  if (
    efforts.some(
      (effort) => !CODEX_EFFORTS.some((allowed) => allowed === effort)
    )
  ) {
    throw new Error("Use low or high effort.");
  }

  const conditions = list(values.conditions);
  const cases = list(values.cases);

  if (cases.includes("all") && cases.length !== 1) {
    throw new Error("all must be used alone in --cases.");
  }

  if (!conditions.every(Schema.is(codexConditionSchema))) {
    throw new Error("Unknown condition.");
  }

  return {
    cases,
    conditions,
    deadlineSeconds: number(values["deadline-seconds"], 10, 600),
    dryRun: values["dry-run"],
    efforts,
    models: list(values.models),
    output: nodePath.resolve(values.output),
    prepareOnly: values["prepare-only"],
    repeats: number(values.repeats, 1, 20),
    seed: number(values.seed, 0, 4_294_967_295),
    startAt: number(values["start-at"], 0, Number.MAX_SAFE_INTEGER),
    totalTokenLimit:
      values["total-token-limit"] === "unlimited"
        ? null
        : number(values["total-token-limit"], 1000, 10_000_000),
    trialTokenLimit: number(values["trial-token-limit"], 1000, 1_000_000),
  };
};

const repeatedTrialBlocks = (
  model: CodexOptions["models"][number],
  effort: CodexOptions["efforts"][number],
  scenario: CodexScenario,
  repeats: number
) =>
  Array.from({ length: repeats }, (_, repeat) => ({
    effort,
    model,
    repeat,
    scenario,
  }));

export const scheduleCodexTrials = function scheduleCodexTrials(
  options: CodexOptions,
  scenarios: readonly CodexScenario[]
) {
  const blocks = options.models.flatMap((model) =>
    options.efforts.flatMap((effort) =>
      scenarios.flatMap((scenario) =>
        repeatedTrialBlocks(model, effort, scenario, options.repeats)
      )
    )
  );

  const random = seededRandom(options.seed);

  return shuffled(blocks, random).flatMap((block) =>
    shuffled(options.conditions, random).map((condition) => ({
      ...block,
      condition,
    }))
  );
};
