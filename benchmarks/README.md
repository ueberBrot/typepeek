# Agent retrieval benchmark

Does Typepeek help an agent retrieve correct, complete information from installed dependencies faster?

The default comparison pairs a files-only control (`files`) with Typepeek plus the shipped skill (`typepeek-skill`). Both receive the same dependency questions, installed packages, model, effort, and static-inspection permissions; only CLI access and skill guidance differ. The agent may still use other static tools in treatment. Reports include CLI adoption, so treatment availability must not be mistaken for actual CLI use.

## Run

Install the locked dependencies and run `vp run pack` first. Live trials require authenticated Codex with model access, app-server raw events, and enforced permission profiles on macOS or Linux (verified with 0.153.4), plus ripgrep. They consume model usage. Preview and verify isolation before spending it:

```bash
vp run benchmark --dry-run
vp run benchmark --prepare-only
vp run benchmark --models gpt-5.6-luna --efforts low --repeats 1 --output .benchmarks/small
```

The default matrix has five tasks, three repetitions, and two conditions across Terra, Luna, Sol, and Astra at low and high effort: **240 attempts**. Seeded scheduling interleaves conditions within each task/model/effort/repetition pair. Keep the machine idle. Use `--help` for task selection, repetitions, output paths, and limits. CLI-only (`typepeek`) and required-CLI-use (`typepeek-required`) remain optional diagnostic conditions, outside the default comparison.

Defaults: 120 seconds per process, a 60,000-token rollout budget per trial, and 2,000,000 reported tokens per campaign. The campaign budget is checked between attempts and can overshoot by one. Missing usage stops further trials; known counts remain recorded. Infrastructure failures stop the campaign and are reported separately from task failures.

Each trial uses a fresh session, isolated host configuration, and reset consumer workspace. Dependencies are read-only. Source, grader, previous answers, host skills, and network access are unavailable. Existing file-based authentication is linked into temporary configuration; credentials are never copied into reports. The benchmark executes the packaged CLI and never builds inside a measurement.

## Read results

Schema v4 measures **task submission to sufficient returned evidence**. A monotonic marker is recorded immediately before sending the task: initial strategy selection and gaps between tool calls count; setup and final-answer writing do not. First-tool-request-to-evidence time remains a diagnostic. Older traces without the submission marker have unknown task-to-evidence time and cannot establish this comparison.

An independent TypeScript consumer constructs the answer key from installed declarations. Grading requires complete signatures or export-name results. Declaration fragments can accumulate across responses, preserving numbered file boundaries. An empty grep result cannot establish absence: that requires a complete export index or verified structured search. A correct final answer without retrieved evidence is insufficient. Unrecognized output formats can remain unverified.

Compare **success rates and per-task times together**. Reports retain failures, coverage, CLI adoption, and paired timing/token ratios among successful pairs; a faster successful subset does not establish a better overall treatment. Intervals describe repeated-run variability within these fixed tasks, not uncertainty across packages. Fewer than five pairs yield no bootstrap interval. Results may favor either condition.

Evidence tokens use pinned `gpt-tokenizer@4.0.0` with `o200k_base`, not model-specific billing. Acquisition model usage is unknown; whole-run usage includes failures and is separate. Cached input is part of input, and reasoning is part of output. Prompt counts include the skill but exclude provider instructions and tool schemas. Raw responses, not display logs, supply evidence. Responses over 262,144 bytes, unsupported content, or compaction before acquisition invalidate measurement.

## Preserve and replay

Use an empty output directory under gitignored `.benchmarks/`; existing runs are never overwritten. Each trial saves its prompt, launch settings, answer schema, independent oracle, raw and timestamped events, final answer, and acquisition grade. `summary.json` and `summary.md` contain campaign results. These artifacts allow grading corrections without new model calls:

```bash
node benchmarks/codex-discovery/replay.ts --trace PATH/events.timed.jsonl --oracle PATH/oracle.json --output .benchmarks/replayed-acquisition.json
```

The replay output must be new. To rebuild the oracle from installed declarations, replace `--oracle` with `--workspace CONSUMER --case execa-command`. Original artifacts remain unchanged.

## Correctness checks

`vp run benchmark:smoke` checks all ten available workloads against the independent oracle with the packaged CLI's cache bypassed and enabled. CI runs this after packing: no model calls, timing thresholds, or separate latency benchmark. Shared oracle, workload, fingerprint, and statistics code lives in `benchmarks/support/`.
