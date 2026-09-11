import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { seededRandom, shuffled } from "../support/statistics.ts";
import type { CodexCondition, CodexScenario } from "./scenarios.ts";

const CODEX_MODELS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"] as const;
const CODEX_EFFORTS = ["low", "high"] as const;
export type CodexOptions = ReturnType<typeof readCodexOptions>;

export function readCodexOptions() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: node benchmarks/codex-discovery/run.ts [options]
  --cases IDS               Comma-separated workload IDs or all (default: five-package suite)
  --models IDS              Codex model IDs (default: Terra, Luna, Sol, Astra)
  --efforts LEVELS          low,high (default: both)
  --conditions VALUES       files,typepeek-skill (default); typepeek and typepeek-required are optional diagnostics
  --repeats N               Fresh trials per task/model/effort/condition (default: 3)
  --deadline-seconds N      Hard per-trial deadline (default: 120)
  --trial-token-limit N     Codex rollout budget per trial (default: 60000)
  --total-token-limit N     Stop launching trials after reported cumulative usage (default: 2000000)
  --seed N                  Reproducible pairing/order seed (default: 1729)
  --output DIRECTORY        Empty directory for trial artifacts (default: timestamped .benchmarks/codex-discovery subdirectory)
  --prepare-only            Verify isolation without making model requests
  --dry-run                 Print the scheduled trials without accessing Codex or creating files

Requires a built dist/, installed dependencies, ripgrep, and authenticated Codex CLI with permission profiles.
The fixtures and grading are deterministic; live Codex time and token usage are statistical observations.
`);
    process.exit(0);
  }
  const { values } = parseArgs({
    options: {
      cases: {
        type: "string",
        default: "execa-command,node-exists,effect-option,stricli-routes,typescript-program",
      },
      models: { type: "string", default: CODEX_MODELS.join(",") },
      efforts: { type: "string", default: CODEX_EFFORTS.join(",") },
      conditions: { type: "string", default: "files,typepeek-skill" },
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
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (process.platform === "win32" && !values["dry-run"])
    throw new Error("Live trials require macOS or Linux sandbox enforcement.");
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
  if (efforts.some((effort) => !CODEX_EFFORTS.some((allowed) => allowed === effort)))
    throw new Error("Use low or high effort.");
  const conditions = list(values.conditions);
  const cases = list(values.cases);
  if (cases.includes("all") && cases.length !== 1)
    throw new Error("all must be used alone in --cases.");
  if (
    conditions.some(
      (condition) =>
        !["files", "typepeek", "typepeek-skill", "typepeek-required"].includes(condition),
    )
  )
    throw new Error("Unknown condition.");
  return {
    cases,
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
    dryRun: values["dry-run"],
  };
}

export function scheduleCodexTrials(options: CodexOptions, scenarios: readonly CodexScenario[]) {
  const blocks = options.models.flatMap((model) =>
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
  return shuffled(blocks, random).flatMap((block) =>
    shuffled(options.conditions, random).map((condition) => ({ ...block, condition })),
  );
}
