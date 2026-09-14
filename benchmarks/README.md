# Agent retrieval benchmark

Does Typepeek help an agent retrieve correct, complete information from installed dependencies faster?

The default comparison pairs a files-only control (`files`) with Typepeek plus the shipped skill (`typepeek-skill`). Both receive the same dependency questions, installed packages, model, effort, and static-inspection permissions; only CLI access and skill guidance differ. The agent may still use other static tools in treatment. Reports include CLI adoption, so treatment availability must not be mistaken for actual CLI use.

All five default questions describe behavior without naming the target export or its file. Agents choose their own search terms and inspection commands.

## Run

Install the locked dependencies and run `vp pack` first. Live trials require authenticated Codex with model access, app-server raw events, and enforced permission profiles on macOS or Linux. Ripgrep is optional; its version or absence is recorded. Live trials consume model usage and run manually, never in CI. Preview and verify isolation before spending it:

```bash
vp run benchmark --dry-run
vp run benchmark --prepare-only
vp run benchmark --models gpt-5.6-luna --efforts low --repeats 1 --output .benchmarks/small
```

The default matrix has five tasks, three repetitions, and two conditions across Terra, Luna, Sol, and Astra at low and high effort: **240 attempts**. Seeded scheduling interleaves conditions within each task/model/effort/repetition pair. Keep the machine idle. Use `--help` for task selection, repetitions, output paths, and limits. CLI-only (`typepeek`) and required-CLI-use (`typepeek-required`) remain optional diagnostic conditions, outside the default comparison.

Defaults: 120 seconds per process, a 60,000-token rollout budget per trial, and 2,000,000 reported tokens per campaign. The campaign budget is checked between attempts and can overshoot by one. Missing usage stops further trials; known counts remain recorded. Infrastructure failures stop the campaign and are reported separately from task failures.

For the full matrix, allow a larger campaign budget:

```bash
vp run benchmark --total-token-limit 10000000
```

Use `--total-token-limit unlimited` to remove the campaign cap. Per-trial limits still apply, and every trial consumes model usage.

Choose the matrix before running and keep the grader, prompts, and CLI build fixed throughout. If the budget cannot cover the full matrix, choose fewer models or effort levels upfront while retaining every task and both conditions. A budget-stopped run is partial, not a balanced replacement.

Each trial uses a fresh session, isolated host configuration, and reset consumer workspace. Dependencies are read-only. Source, grader, previous answers, host skills, and network access are unavailable. Existing file-based authentication is linked into temporary configuration; credentials are never copied into reports. The benchmark executes the packaged CLI and never builds inside a measurement.

## Read results

Schema v4 measures **task submission to sufficient returned evidence**. A monotonic marker is recorded immediately before sending the task: initial strategy selection and gaps between tool calls count; setup and final-answer writing do not. First-tool-request-to-evidence time remains a diagnostic. Measurement requires the task-submission marker.

An independent TypeScript consumer constructs the answer key from installed declarations. Grading requires complete signatures or export-name results. Declaration fragments can accumulate across responses, preserving numbered file boundaries. Codex command-result JSON wrappers are decoded for matching; token counts still use the original responses. An empty grep result cannot establish absence: that requires a complete export index or verified structured search. A correct final answer without retrieved evidence is insufficient. Unrecognized output formats can remain unverified.

Compare **success rates and per-task times together**. Reports retain failures, coverage, CLI adoption, and paired timing/token ratios among successful pairs; a faster successful subset does not establish a better overall treatment. Intervals describe repeated-run variability within these fixed tasks, not uncertainty across packages. Fewer than five pairs yield no bootstrap interval. Results may favor either condition.

### Published results

The README summarizes 240 attempts: 120 per condition, with 15 per model/effort/condition. The grader verified 118 files-only attempts and all 120 CLI attempts. Every CLI attempt used Typepeek. Matched medians include 24 pairs per task, except TypeScript and Effect with 23 each.

One files-only TypeScript attempt failed to retrieve the required signatures. One files-only Effect attempt retrieved the correct signature, but the grader did not recognize it. Both remain unverified under the recorded grading rules.

Whole-task usage totaled 5,004,245 tokens for files alone and 3,288,291 for CLI plus skill, a 34.3% reduction. Across verified pairs, the pooled median was 29,475.5 tokens for files and 32,583.5 for CLI, a 10.5% increase. Totals include expensive discovery attempts, so lower total usage does not imply savings on a typical task.

The run completed in two segments after an interruption: 155 attempts followed by the remaining 85. All scheduled trials are present once. Both segments used Codex 0.154.0 with matching CLI, skill, dependency, and environment fingerprints. Only scheduling support changed to skip completed trials; prompts and grading stayed fixed. One pair spans the interruption. Raw traces remain local under `.benchmarks/` and are not committed.

Evidence tokens use pinned `gpt-tokenizer@4.0.0` with `o200k_base`, not model-specific billing. Acquisition model usage is unknown; whole-run usage includes failures and is separate. Cached input is part of input, and reasoning is part of output. Prompt counts include the skill but exclude provider instructions and tool schemas. Raw responses, not display logs, supply evidence. Responses over 262,144 bytes, unsupported content, or compaction before acquisition invalidate measurement.

## Preserve and replay

Use an empty output directory under gitignored `.benchmarks/`; existing runs are never overwritten. Each trial saves its prompt, launch settings, answer schema, independent oracle, raw and timestamped events, final answer, and acquisition grade. `summary.json` and `summary.md` contain campaign results. These artifacts allow grading corrections without new model calls:

```bash
node benchmarks/codex-discovery/replay.ts --trace PATH/events.timed.jsonl --oracle PATH/oracle.json --output .benchmarks/replayed-acquisition.json
```

The replay output must be new. To rebuild the oracle from installed declarations, replace `--oracle` with `--workspace CONSUMER --case execa-command`. Original artifacts remain unchanged.

To continue an interrupted campaign, use `--start-at N` with a new output directory, where `N` is the number of consecutive completed trials. Keep the original matrix and seed. This skips scheduled trials; it does not load or validate earlier results. Before combining segments, verify matching build, skill, evidence, and measurement rules, and check for missing or duplicate trials. Retain failed attempts and disclose interruptions.

## Correctness checks

`vp run benchmark:smoke` checks all ten available workloads against the independent oracle with the packaged CLI's cache bypassed and enabled. CI runs this after packing, without model calls or timing thresholds. Shared oracle, workload, fingerprint, and statistics code lives in `benchmarks/support/`.
