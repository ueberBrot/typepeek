# Agent benchmark

Typepeek plus its skill versus files-only inspection. Results from 2026-11-06: four models, low/high effort, three repeats, and fresh Docker sandbox sessions.

| Task | Time: files → Typepeek | Time saved | Tokens: files → Typepeek | Tokens saved |
| --- | --: | --: | --: | --: |
| Semver clean | 12.3 s → 8.9 s | 27.8% | 36.9k → 23.3k | 36.9% |
| Node existsSync | 10.1 s → 8.2 s | 19.0% | 27.6k → 21.2k | 23.0% |
| Effect getOrNull | 14.5 s → 10.0 s | 30.8% | 46.0k → 26.4k | 42.7% |
| Effect map | 15.2 s → 10.7 s | 30.0% | 46.0k → 23.1k | 49.8% |
| TSRS createFileSystem | 14.5 s → 14.7 s | -1.5% | 48.2k → 35.0k | 27.3% |
| **All tasks** | **13.4 s → 10.6 s** | **21.0%** | **41.3k → 26.0k** | **37.0%** |

Means cover 112 matched successful pairs. Verified evidence: Typepeek 119/120, files 112/120, including two known grader misses. This fixed workload does not measure a CLI version change. [Recorded data](results/2026-11-06.json). [CLI runtime comparison](results/2026-11-06-runtime.json) is measured separately, without model calls.

## What is measured

| Mean seconds per matched task     | Files | Typepeek |
| --------------------------------- | ----: | -------: |
| Submission through final answer   | 13.40 |    10.59 |
| Tool round trips                  |  0.50 |     2.45 |
| Outside tools                     | 12.89 |     8.14 |
| Submission to sufficient evidence |  9.09 |     6.94 |

Setup and cleanup are excluded; overlapping tool calls count once. Outside-tool time includes model generation, provider latency, and orchestration. Tokens are reported input plus output, including cached input. Across all 240 attempts, including failures, Typepeek used 34.2% fewer tokens.

## Run

Install the locked dependencies and configure Docker login, Codex OAuth, and network policy. `vp run sandbox --help` lists requirements. Live trials consume model usage.

```bash
vp run benchmark --dry-run
vp run sandbox -- benchmark --prepare-only
vp run sandbox --timeout-seconds 32400 -- benchmark --total-token-limit unlimited
```

Rebuild the matrix from saved traces without model calls:

```bash
vp run benchmark:matrix --summary PATH/summary.json --output .benchmarks/new-matrix
```

Keep tasks, models, effort, environment, and grading fixed for later comparisons. Raw traces, answers, grades, and fingerprints stay under `.benchmarks/`. VMs are removed automatically; retry interrupted cleanup with `vp run sandbox --cleanup RUN_DIRECTORY`.
