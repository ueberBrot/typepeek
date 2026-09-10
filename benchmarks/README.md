# Benchmarks

Two suites use the same installed dependencies and independent TypeScript oracle:

| Suite     | Measures                                               | Command                      |
| --------- | ------------------------------------------------------ | ---------------------------- |
| Discovery | Fresh-process latency, returned bytes, and correctness | `vp run benchmark:discovery` |
| Codex     | Time and returned tokens to sufficient evidence        | `vp run benchmark:codex`     |

Install the locked dependencies and run `vp run pack` first. Benchmarks execute the packaged CLI; building and oracle construction stay outside the timer. Generated artifacts belong in the gitignored `.benchmarks/` directory.

## Artifacts

| File                                    | Contents                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery `<run>.json`                  | Measured samples, statistics, grading, and input fingerprints. Select a compatible measured run with `--compare` to use it as a performance baseline. |
| `<run>.json.traces.jsonl`               | Commands, stdout, stderr, and observations, including excluded warmups.                                                                               |
| Codex `summary.json`, `result.json`     | Campaign summaries and individual trial measurements and grades.                                                                                      |
| Codex `events.jsonl`                    | Codex events, including recorded commands and reported token usage.                                                                                   |
| Codex `events.timed.jsonl`              | Native events timestamped as they arrive, using a monotonic clock.                                                                                    |
| Codex `oracle.json`, `acquisition.json` | Independent answer key, first sufficient response, matched facts, and acquisition measurements.                                                       |
| Codex `answer.json`                     | The model's answer; the grader may reject it.                                                                                                         |
| Codex `answer.schema.json`              | The required answer format, not the correct answer.                                                                                                   |
| Codex `launch.json`, `prompt.txt`       | Trial configuration and model instructions.                                                                                                           |

`expectedFacts` comes from an independent TypeScript consumer reading installed declarations. It is the correctness answer key. Timing tolerances are chosen limits; synthetic numbers in tests verify calculations and are never benchmark observations.

## Discovery

The ten workloads cover Execa, Node declarations, Effect, Stricli, and TypeScript. Each compares an independent compiler consumer with cache-bypassed and cache-primed Typepeek processes. Five workloads also support a fixed ripgrep/file-reading baseline.

```bash
node benchmarks/discovery/run.ts --case execa-command --iterations 15 --output .benchmarks/discovery/baseline.json --check
node benchmarks/discovery/run.ts --case execa-command --iterations 15 --compare .benchmarks/discovery/baseline.json --output .benchmarks/discovery/current.json
```

Each run gets a unique output path by default. Explicit paths must be unused; existing reports and traces are never overwritten. JSON reports retain every measured sample; adjacent `.traces.jsonl` files retain commands, output, errors, and excluded warmups. The default is 15 measurements after two warmups. Seeded condition order balances execution positions. OS caches are not flushed; a primed Typepeek cache does not guarantee a cache hit.

Grading compares complete signatures or export-name matches, ignoring formatting trivia. Incorrect results never contribute to speedup ratios. Reports include median, p95, sample variability, mean confidence intervals, and paired bootstrap intervals. Small-sample p95 values are descriptive.

Correctness failures exit with code 1. `--check` also requires at least five samples and CV ≤20%. `--compare` rejects incompatible inputs and median regressions exceeding `max(10%, 10 ms)`. Run comparisons on the same idle machine. Fixture and scheduling determinism do not make wall-clock timings deterministic.

CI runs `vp run benchmark:smoke` after packing to check all ten workloads without timing thresholds or model calls. Report schema v2 records the selected workload set; older reports require a fresh baseline.

## Codex

The default matrix uses five tasks, three repetitions, and three conditions: files-only control (`files`), CLI without skill guidance (`typepeek`), and CLI with an explicit `$typepeek` request and the shipped skill text (`typepeek-skill`). That schedules **360 attempts** across these eight runners:

| Model           | Efforts   |
| --------------- | --------- |
| `gpt-5.6-terra` | low, high |
| `gpt-5.6-luna`  | low, high |
| `gpt-5.6-sol`   | low, high |
| `gpt-6-astra`   | low, high |

Live trials require authenticated Codex with model access, app-server raw events, and enforced permission profiles on macOS or Linux (verified with 0.153.4). They consume model usage. Verify isolation before launching a campaign:

```bash
node benchmarks/codex-discovery/run.ts --dry-run
node benchmarks/codex-discovery/run.ts --prepare-only
node benchmarks/codex-discovery/run.ts --models gpt-5.6-luna --efforts low --repeats 1 --output .benchmarks/codex-small
```

Each attempt gets a fresh session, isolated Codex configuration, and reset consumer workspace. Existing file-based authentication is linked into the temporary Codex configuration; no credentials are copied into reports. Installed dependencies are read-only; source, grader, prior answers, host skills, and network tools are unavailable. Discovered host skills are explicitly disabled. CLI-only attempts choose whether to use Typepeek; skill attempts explicitly request the supplied skill. `typepeek-required` additionally grades successful CLI use of the requested interface; select it with `--conditions`.

The default limits are 120 seconds and a 60,000-token rollout budget per attempt, plus 2,000,000 reported tokens per campaign. The campaign limit is checked between attempts and can overshoot by one attempt. Rollout accounting differs from reported input/output usage. Keep the host awake and other workloads idle.

Each campaign requires an empty output directory and saves prompts, launch settings, events, answers, grades, and JSON/Markdown summaries. Reports retain failures, per-task results, and paired successful comparisons. Missing usage stays unknown; cached input is part of input, and reasoning is part of output. Incomplete usage stops further trials because budget accounting is unavailable. Infrastructure failures stop the campaign and remain separate from task failures.

Schema v3 measures from the first tool request to the first tool response containing all required evidence. This includes gaps between retrieval calls, but excludes initial reasoning, setup, and final-answer generation. The grader accepts independently verified structured CLI results or complete declaration witnesses across responses. Name-search absence requires a complete export index or verified structured search result; an empty grep result is insufficient. Other output formats can remain unverified even when the final answer is correct. Inspect matched call IDs and missing facts in `acquisition.json`.

Evidence tokens count returned text using `gpt-tokenizer@4.0.0` with `o200k_base`, a reference encoding rather than a model-specific billing claim. Prompt tokens include the supplied skill; the skill subtotal must not be added again. Provider instructions and tool schemas are excluded from those prompt counts. Acquisition model usage stays unknown: whole-run input/output usage is a separate diagnostic, not an acquisition estimate. Tool round-trip time is summed separately from reported command execution durations; parallel durations can overlap.

Native raw responses, not display logs, supply evidence. The harness raises the history output budget and rejects responses over 262,144 bytes or context compaction before acquisition completes. Unsupported or incomplete traces must not be treated as zero-cost successes. Old untimed traces cannot recover acquisition timings.

Reports show absolute acquisition time and evidence tokens, per-task results, coverage, and paired successful ratios. Confidence intervals describe run variability within these fixed tasks. `precisionWithinTenPercent` reports whether the observed mean's 95% interval meets ±10%; insufficient samples yield unknown, not a fabricated tolerance. Uneven or incomplete campaigns do not establish balanced model comparisons. Model outputs and service latency remain nondeterministic.

Replay a saved trace without model access (the output file must be new):

```bash
node benchmarks/codex-discovery/replay.ts --trace PATH/events.timed.jsonl --oracle PATH/oracle.json --output .benchmarks/replayed-acquisition.json
```

Use `--workspace CONSUMER --case execa-command` instead of `--oracle` to rebuild the answer key from installed declarations.

Both runners accept `--help` for workload selection, repetitions, limits, and output options.
