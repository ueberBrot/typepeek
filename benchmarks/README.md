# Benchmarks

Two suites use the same installed dependencies and independent TypeScript oracle:

| Suite     | Measures                                               | Command                      |
| --------- | ------------------------------------------------------ | ---------------------------- |
| Discovery | Fresh-process latency, returned bytes, and correctness | `vp run benchmark:discovery` |
| Codex     | Agent correctness, elapsed time, and tokens            | `vp run benchmark:codex`     |

Install the locked dependencies and run `vp run pack` first. Benchmarks execute the packaged CLI; building and oracle construction stay outside the timer. Generated artifacts belong in the gitignored `.benchmarks/` directory.

## Artifacts

| File                                | Contents                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery `<run>.json`              | Measured samples, statistics, grading, and input fingerprints. Select a compatible measured run with `--compare` to use it as a performance baseline. |
| `<run>.json.traces.jsonl`           | Commands, stdout, stderr, and observations, including excluded warmups.                                                                               |
| Codex `summary.json`, `result.json` | Campaign summaries and individual trial measurements and grades.                                                                                      |
| Codex `events.jsonl`                | Codex events, including recorded commands and reported token usage.                                                                                   |
| Codex `answer.json`                 | The model's answer; the grader may reject it.                                                                                                         |
| Codex `answer.schema.json`          | The required answer format, not the correct answer.                                                                                                   |
| Codex `launch.json`, `prompt.txt`   | Trial configuration and model instructions.                                                                                                           |

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

Live trials require authenticated Codex with model access and enforced permission profiles on macOS or Linux. They consume model usage. Verify isolation before launching a campaign:

```bash
node benchmarks/codex-discovery/run.ts --dry-run
node benchmarks/codex-discovery/run.ts --prepare-only
node benchmarks/codex-discovery/run.ts --models gpt-5.6-luna --efforts low --repeats 1 --output .benchmarks/codex-small
```

Each attempt gets a fresh session and reset consumer workspace. Installed dependencies are read-only; source, grader, prior answers, host skills, and network tools are unavailable. CLI-only attempts choose whether to use Typepeek; skill attempts explicitly request the supplied skill. `typepeek-required` additionally grades successful CLI use of the requested interface; select it with `--conditions`.

The default limits are 120 seconds and a 60,000-token rollout budget per attempt, plus 2,000,000 reported tokens per campaign. The campaign limit is checked between attempts and can overshoot by one attempt. Rollout accounting differs from reported input/output usage. Keep the host awake and other workloads idle.

Each campaign requires an empty output directory and saves prompts, launch settings, events, answers, grades, and JSON/Markdown summaries. Reports retain failures, per-task results, and paired successful comparisons. Missing usage stays unknown; cached input is part of input, and reasoning is part of output. Incomplete usage stops further trials because budget accounting is unavailable. Infrastructure failures stop the campaign and remain separate from task failures.

Paired ratios describe successful pairs within these fixed tasks, not performance across all packages. Read correctness and tokens per correct answer alongside time ratios. Model outputs and service latency remain nondeterministic.

Both runners accept `--help` for workload selection, repetitions, limits, and output options.
