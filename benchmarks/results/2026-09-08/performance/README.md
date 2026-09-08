# Inspection performance investigation

The [follow-up performance audit](full-audit/README.md) measures the final implementation across ten workloads. Cold latency falls by another 17.5–26.2% relative to the first improvements below. The original measurements and agent pilot remain recorded here.

## First performance improvements

Typepeek’s inspection of the exported `execa` function in the installed `execa` package fell from **1,672 ms to 1,379 ms**, a 17.5% reduction in mean cold latency. All measured answers matched the independent compiler oracle, including generics, overload order, array types, and rest parameters. The compiler query still took 447 ms; this improvement does not establish a Typepeek speed advantage for this workload.

| Implementation                          | Cold mean ± 95% CI | Cache-enabled mean ± 95% CI |
| --------------------------------------- | -----------------: | --------------------------: |
| Original                                |      1,672 ± 55 ms |               1,654 ± 29 ms |
| One path check per compiler probe       |      1,560 ± 29 ms |               1,573 ± 36 ms |
| One path check plus bounded read chunks |       1,379 ± 7 ms |               1,374 ± 12 ms |

Each row has seven measured repetitions per method, two warmups, and the same shuffle seed, installed dependencies, host, and consumer path. Every observation starts a fresh process. The runner used prepacked artifacts; packing was outside the measurements. Cache-enabled runs prime the persistent cache but do not prove cache hits. This workload's evidence proof exceeds the cache receipt limit, so persistent reuse remains unavailable.

The JSON files preserve individual samples, independent-oracle verdicts, machine and dependency identities, and exact artifact hashes. Their commit field identifies the common starting commit, `cff015e`; the candidate source edits were uncommitted while measuring. Artifact hashes distinguish each measured implementation. These are sequential experiments on one Apple M1 Max, not randomized before/after pairs or cross-platform estimates.

## Causes and changes

The packaged worker's CPU profile showed repeated path canonicalization during compiler resolution and substantial garbage collection. Two consecutive authorization checks canonicalized each candidate separately. One check now verifies the lexical and canonical boundary together. It still runs before cached filesystem results are returned, so it does not cache away symlink validation. Existing tests cover installed layouts, inaccessible roots, relative symlink escapes, and Node declaration authority.

Evidence reads previously allocated the caller's entire remaining byte budget for every file. A small manifest could therefore allocate megabytes. Reads now use chunks of at most 64 KiB, retain the sentinel byte that detects overflow, and join bytes before UTF-8 decoding. Exact byte limits, empty files, overflow, and multibyte characters crossing read boundaries are tested. A diagnostic worker profile showed garbage-collection self time falling from about 144 ms to 60 ms; profiler timings are not included in the normal benchmark samples.

The separate native-path-resolution probe did not produce a reliable gain and was reverted. Its samples remain in `execa-native-path-check.json`, including a slower cold outlier. The final implementation uses the original path-resolution API. No cache budget, declaration authority, subprocess limit, or signature fidelity requirement was relaxed.

## Agent failures

The earlier 90-attempt study remains unchanged. Its nine failed attempts comprise five completions without commands, three final-answer transcription failures, and one host-sleep interruption. The transcription failures were a missing generic parameter, added `undefined` unions in optional parameter types, and an inserted control character. The relevant CLI outputs were correct. Available tools alone also did not ensure adoption: Sol used Typepeek in 1/15 CLI-available attempts and 15/15 skill-guided attempts.

The new `typepeek-required` condition explicitly requires a successful JSON inspection of the requested module and export, includes the shipped skill, and instructs the model to copy signature text. Its tool-use grade rejects help-only, failed, and wrong-module commands. The final answer still has to pass the independent oracle. This is a prescribed workflow and must be reported separately from voluntary adoption. An agent that ignores the requirement still fails; the harness does not relabel or retry it into a success.

A recovery experiment remains separate work: it must retain first-attempt failures, use a fixed retry allowance, and charge all retry time and tokens. This change does not claim to have measured recovery or eliminated model failures.

## Required-use verification pilot

Both models passed both tasks at low effort, with one fresh attempt per task and no retries:

| Model | Task                     | Correct / attempts |   Time | Reported input + output tokens |
| ----- | ------------------------ | -----------------: | -----: | -----------------------------: |
| Luna  | Effect generic signature |                1/1 | 15.5 s |                         36,317 |
| Luna  | TypeScript overloads     |                1/1 | 10.2 s |                         24,079 |
| Sol   | Effect generic signature |                1/1 | 28.7 s |                         36,380 |
| Sol   | TypeScript overloads     |                1/1 | 16.7 s |                         24,224 |

All four traces contain successful installed-evidence inspections whose signature text matches the independent oracle. All four final answers preserve the generic parameter and declared overloads. Total reported usage is **121,000 tokens**, including cached input within input totals. The [archive](codex-required-pilot.json) retains prompts, answers, command outputs, grades, timing, usage, and identities. This four-attempt pilot has no control arm and cannot establish a reliability improvement, time advantage, or token savings.

The first isolation preflight was attempted from the performance worktree under `/private/tmp`. It detected that the grader was readable and stopped before any model calls. The pilot then used the same committed harness and prepacked artifact in a detached checkout outside shared temporary directories. Isolation passed without weakening any check. A later audit found that this preflight had not excluded a readable sibling checkout under `/private/tmp`. The six recorded pilot commands are all Typepeek invocations, but the limitation is retained in the archive; the [follow-up audit](full-audit/README.md#isolation-correction-before-the-agent-rerun) documents the stronger check. An evidence-parser follow-up removes duplicate records caused by trailing-newline JSON; replaying all four traces preserves every original tool-use grade. Archived original telemetry remains unchanged.

## Verification

Formatting, lint, types, Effect diagnostics, Fallow, build and package smoke checks, the seven packaged regression gates, and the four-method discovery smoke check pass. Standards and spec review have no remaining findings.

The initial full-suite run passed 525 tests but hit two package-fixture failures under restricted networking and two failures under unrestricted parallel load. Rerunning the affected 72 tests with CI's two-worker setting and required network access passed; the additional required-search and trailing-newline regressions also pass. No product deadline or resource limit was increased to accommodate the tests.
