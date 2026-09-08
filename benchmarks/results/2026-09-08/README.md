# Dependency discovery measurements, 2026-09-08

Explicit skill guidance changed how the models used Typepeek. In the post-fix study, Sol invoked the CLI in only 1/15 attempts when it was merely available, versus 15/15 with the skill. Luna invoked it in 14/15 attempts in each treatment. Skill-guided successful runs were faster on average for both models, but benefits varied by package, and Luna's full token result is incomplete because the host slept during one attempt.

## Three conditions after the fixes

The main study contains 90 attempts: five installed package families × two models × three conditions × three fresh repetitions. The models were `gpt-5.6-luna` and `gpt-5.6-sol`, both at low reasoning effort. Files-only permits autonomous static inspection; CLI available adds the prepacked Typepeek executable; CLI + skill also supplies the checked-in skill verbatim. Every condition can choose its inspection strategy. The third condition measures explicit guidance and its input tokens, not automatic skill discovery overhead. No builds, linters, or test suites ran during these measurements.

| Model | Condition     | Correct | Successful mean time ± 95% CI | Input tokens | Cached input | Output tokens | Tokens per correct answer |
| ----- | ------------- | ------- | ----------------------------- | ------------ | ------------ | ------------- | ------------------------- |
| luna  | Files         | 13/15   | 26.7 ± 8.1 s                  | 827,882      | 538,880      | 10,913        | 64,523                    |
| luna  | CLI available | 13/15   | 17.8 ± 2.1 s                  | 569,398      | 439,808      | 6,442         | 44,295                    |
| luna  | CLI + skill   | 12/15   | 13.0 ± 1.7 s                  | 392,060      | 240,896      | 4,050         | unknown                   |
| sol   | Files         | 14/15   | 31.1 ± 11.4 s                 | 668,716      | 481,024      | 9,030         | 48,410                    |
| sol   | CLI available | 14/15   | 28.7 ± 12.1 s                 | 658,890      | 477,440      | 8,163         | 47,647                    |
| sol   | CLI + skill   | 15/15   | 20.7 ± 3.8 s                  | 476,423      | 345,088      | 4,774         | 32,080                    |

Token totals include failures. Cached input is already included in input; reasoning is already included in output. Luna's skill totals are lower bounds: the sleep-affected attempt has no final usage event, so its full tokens-per-correct value is unknown. Time intervals are Student t intervals over successful runs within these fixed tasks. They do not describe uncertainty across packages. The complete archive also reports all-attempt times and success by deadline; the sleep interruption raises Luna's skill all-attempt mean to 51.2 seconds.

For Sol, the skill reduced aggregate tokens per correct answer by 32.7% relative to CLI availability alone, while correctness rose from 14/15 to 15/15. That aggregate is dominated by the TypeScript compatibility package: the skill goes directly to its complete signature, while Sol usually follows re-exports without the CLI. On Execa and Effect, the skill instead performs extra discovery commands. These are exploratory results for the installed versions and selected tasks, not a general model ranking.

### Paired comparisons

Each row compares the same task, model, and repetition where both conditions passed. A ratio above 1 favors the denominator. Brackets show seeded, run-level 95% bootstrap intervals. Failure filtering matters: read these ratios alongside correctness and all-attempt token totals.

| Comparison                  | Successful pairs | Median time ratio [95% interval] | Median token ratio [95% interval] |
| --------------------------- | ---------------- | -------------------------------- | --------------------------------- |
| luna: files / CLI available | 11               | 1.192 [0.907, 1.416]             | 1.103 [0.961, 1.655]              |
| luna: files / skill         | 10               | 1.538 [1.206, 2.571]             | 1.577 [1.364, 2.705]              |
| luna: CLI available / skill | 11               | 1.372 [1.062, 1.689]             | 1.426 [1.271, 1.624]              |
| sol: files / CLI available  | 13               | 1.054 [0.947, 1.369]             | 0.998 [0.989, 1.432]              |
| sol: files / skill          | 14               | 0.970 [0.722, 1.893]             | 0.911 [0.704, 1.597]              |
| sol: CLI available / skill  | 14               | 1.002 [0.709, 1.252]             | 0.915 [0.712, 0.933]              |

Luna's skill-guided paired successes used less time and fewer tokens than CLI availability alone in this sample. Sol's median paired time was near parity; its median token ratio favored CLI availability, despite the skill's lower aggregate token total. Large savings on TypeScript coexist with smaller costs on several other tasks. The [skill comparison](codex-skill-comparison.json) records the matched pairs; comparisons against files-only are in the [main archive](codex-three-conditions-post-fix.json).

### Results by package

Times below are means over successful attempts, with at most three observations per cell. Correctness counts include every attempt. Full timing samples and intervals are in the archive.

| Model | Task                     | Files correct | Files time | CLI available correct | CLI available time | Skill correct | Skill time |
| ----- | ------------------------ | ------------- | ---------- | --------------------- | ------------------ | ------------- | ---------- |
| luna  | Execa parser             | 2/3           | 14.7 s     | 2/3                   | 13.9 s             | 3/3           | 14.9 s     |
| luna  | Node existsSync          | 3/3           | 21.0 s     | 3/3                   | 17.4 s             | 3/3           | 11.0 s     |
| luna  | Effect getOrNull         | 3/3           | 24.1 s     | 3/3                   | 22.1 s             | 2/3           | 16.0 s     |
| luna  | Stricli buildRouteMap    | 2/3           | 19.7 s     | 3/3                   | 16.8 s             | 2/3           | 12.6 s     |
| luna  | TypeScript createProgram | 3/3           | 47.6 s     | 2/3                   | 17.4 s             | 2/3           | 10.7 s     |
| sol   | Execa parser             | 3/3           | 21.3 s     | 3/3                   | 19.3 s             | 3/3           | 30.0 s     |
| sol   | Node existsSync          | 2/3           | 13.6 s     | 2/3                   | 15.2 s             | 3/3           | 14.5 s     |
| sol   | Effect getOrNull         | 3/3           | 25.4 s     | 3/3                   | 20.3 s             | 3/3           | 26.0 s     |
| sol   | Stricli buildRouteMap    | 3/3           | 24.2 s     | 3/3                   | 18.9 s             | 3/3           | 17.6 s     |
| sol   | TypeScript createProgram | 3/3           | 64.9 s     | 3/3                   | 65.4 s             | 3/3           | 15.4 s     |

Tokens per correct answer use all reported input plus output, including failed attempts:

| Model | Task                     | Files tokens/correct | CLI available tokens/correct | Skill tokens/correct |
| ----- | ------------------------ | -------------------- | ---------------------------- | -------------------- |
| luna  | Execa parser             | 46,972               | 43,060                       | 32,192               |
| luna  | Node existsSync          | 56,683               | 41,655                       | 27,846               |
| luna  | Effect getOrNull         | 58,082               | 47,364                       | 54,012               |
| luna  | Stricli buildRouteMap    | 53,320               | 39,746                       | unknown              |
| luna  | TypeScript createProgram | 97,973               | 51,713                       | 29,999               |
| sol   | Execa parser             | 33,322               | 30,443                       | 48,404               |
| sol   | Node existsSync          | 26,932               | 27,142                       | 23,799               |
| sol   | Effect getOrNull         | 38,483               | 30,228                       | 40,230               |
| sol   | Stricli buildRouteMap    | 29,989               | 21,989                       | 23,988               |
| sol   | TypeScript createProgram | 106,167              | 121,597                      | 23,978               |

### Failures and evidence review

All 81 passing answers had supporting installed declaration evidence in their command traces. The nine failures were:

- Five attempts with no inspection command: Luna's Execa files-only and CLI-available attempts, Luna's TypeScript skill attempt, and one Sol Node attempt in each of files-only and CLI-available. The TypeScript answer also supplied incorrect overloads.
- Luna's Effect skill answer omitted the generic parameter, although Typepeek returned it correctly.
- Luna's TypeScript CLI-available answer expanded optional parameter types with `| undefined` instead of copying the declared signature text. This fails the prespecified exact-interface grader; it is not evidence of a runtime type mismatch. Typepeek's exact signature text was correct.
- Luna's files-only Stricli answer inserted a DEL control character into the signature.
- The host-sleep timeout described below.

Two CLI-available attempts recovered from invalid flag combinations: `--pretty` without `--json`, and `overview --match` with `--json`. Their retries remain in the measurements. No inspected failure exposed a new incorrect CLI signature after the product fixes. The archive preserves command outputs, answers, grading errors, prompts, versions, and hashes; hidden model reasoning is omitted.

### Host sleep and separate repeat

macOS power-management logs record idle sleep from 16:08:36 to 16:18:16 UTC, overlapping Luna's first Stricli skill attempt. Its saved trace contains a correct CLI result but no completed model turn. The timeout fired after wake, giving 585.2 seconds of recorded elapsed time despite a configured 120-second deadline. Final usage is unknown. The original attempt remains a failure in the main study. Idle sleep was prevented for the remaining measurements.

The [sensitivity analysis](codex-sleep-sensitivity.json) excludes that complete three-condition block, leaving 87 attempts. Sol is unchanged. Luna then has the following results; this view has fewer Stricli repetitions and is not balanced across tasks:

| Luna condition | Correct | Successful mean time ± 95% CI | Tokens per correct answer |
| -------------- | ------- | ----------------------------- | ------------------------- |
| Files          | 12/14   | 27.2 ± 8.8 s                  | 66,911                    |
| CLI available  | 12/14   | 18.0 ± 2.3 s                  | 45,062                    |
| CLI + skill    | 12/14   | 13.0 ± 1.7 s                  | 33,009                    |

Prompt caching changes the interpretation of token savings. In this sensitivity view, Luna's skill used fewer total tokens per correct answer but more uncached-input-plus-output tokens: 12,935 versus 10,993 with CLI availability alone. The corresponding Sol values were 9,074 versus 13,544. These counts expose cache differences; they do not establish monetary charges.

A [separate Stricli repeat](codex-sleep-supplement.json) used the same Luna/low setting, three conditions, packaged artifact, and skill after the main campaign. All three attempts passed:

| Condition     | Correct | Time   | Total tokens |
| ------------- | ------- | ------ | ------------ |
| Files         | 1/1     | 18.4 s | 34,893       |
| CLI available | 1/1     | 20.5 s | 35,375       |
| CLI + skill   | 1/1     | 14.3 s | 24,038       |

The repeat consumed 94,306 reported tokens. It does not replace the original failure or enter the main estimates. Its single observation per condition does not support an interval.

## Normal installation before the fixes

Typepeek produced 13 correct answers out of 15 attempts; files-only produced 12. Tokens per correct answer were lower with Typepeek, while the paired timing and token intervals both included parity. This exploratory sample does not establish a general advantage across packages or models.

| Condition        | Correct | Successful mean time | Input tokens | Cached input | Output tokens | Tokens per correct answer |
| ---------------- | ------- | -------------------- | ------------ | ------------ | ------------- | ------------------------- |
| Files            | 12/15   | 26.2 ± 6.5 s         | 837,710      | 652,800      | 10,498        | 70,684                    |
| Files + Typepeek | 13/15   | 24.4 ± 5.2 s         | 678,822      | 523,776      | 7,386         | 52,785                    |

The time intervals are 95% Student t intervals over successful runs. They describe variability within these fixed tasks, not uncertainty across a population of packages. Token totals include failures. Cached input is a subset of input, and reasoning is a subset of output; neither is added twice.

| Task                       | Files correct | Typepeek correct | Files mean time | Typepeek mean time | Files tokens/correct | Typepeek tokens/correct |
| -------------------------- | ------------- | ---------------- | --------------- | ------------------ | -------------------- | ----------------------- |
| Execa command parser       | 3/3           | 3/3              | 17.0 s          | 18.3 s             | 46,998               | 47,950                  |
| Node `existsSync`          | 3/3           | 1/3              | 28.1 s          | 16.7 s             | 67,869               | 55,251                  |
| Effect `getOrNull`         | 1/3           | 3/3              | 29.6 s          | 31.1 s             | 159,013              | 50,231                  |
| Stricli `buildRouteMap`    | 3/3           | 3/3              | 20.3 s          | 19.5 s             | 35,979               | 35,253                  |
| TypeScript `createProgram` | 2/3           | 3/3              | 44.4 s          | 31.5 s             | 118,328              | 76,885                  |

Among the ten pairs where both conditions passed, the median files/Typepeek time ratio was 1.146, with a run-level bootstrap interval of [0.961, 1.500]. The token ratio was 1.070 [0.994, 1.620]. Ratios above 1 favor Typepeek. These selected pairs exclude failures; use the correctness and tokens-per-correct columns alongside them.

Two files-only Effect answers omitted the generic parameter. Two Typepeek Node answers and one files-only TypeScript answer issued no command and failed the inspection gate. All remaining traces contained declaration reads or relevant CLI inspections. Typepeek was invoked in 13/15 treatment attempts. The Effect treatment recovered from a wrong entrypoint and an invalid flag combination; those attempts remained in the results.

The [complete pre-fix result](codex-contained-pre-fix.json) includes prompts, answers, expected facts, command traces, CLI outcomes, timing samples, and token breakdowns. The packaged artifact hash is `d4943e30c0d73aff9e427861e7e132d29d242bb37463b605483f92a0a6e8dbd0`, built from `cac82788ac1a6c7c9c5109c08951648dcff43b48`.

## Local retrieval after the fixes

All 175 measured observations across ten workloads returned the expected exact interfaces: 100 Typepeek observations, 50 independent-compiler observations, and 25 file replays. Before the fix, ten Typepeek observations failed on Execa’s invocation overloads. Structured-field fidelity is checked separately by the packaged CLI regression tests.

Each cell below is mean milliseconds ± a 95% Student t interval from five repetitions after two excluded warmups. Every method’s CV was below 7%. These are process retrieval times; file replay already knows the export name, and the compiler baseline is a purpose-built helper. They exclude agent search decisions and answer generation.

| Workload           | File replay | Compiler | Typepeek, cache bypassed | Typepeek, cache primed |
| ------------------ | ----------- | -------- | ------------------------ | ---------------------- |
| execa-command      | 69 ± 3      | 405 ± 20 | 960 ± 46                 | 953 ± 20               |
| execa-cancellation | 71 ± 2      | 427 ± 24 | 1121 ± 97                | 1093 ± 74              |
| execa-invocation   | —           | 449 ± 7  | 1714 ± 53                | 1708 ± 50              |
| execa-errors       | —           | 407 ± 10 | 1505 ± 35                | 1498 ± 46              |
| execa-absent       | —           | 407 ± 9  | 1533 ± 47                | 1507 ± 39              |
| node-read-file     | 75 ± 4      | 575 ± 20 | 1362 ± 25                | 1330 ± 42              |
| node-exists        | 70 ± 2      | 551 ± 4  | 1305 ± 20                | 1289 ± 16              |
| effect-option      | —           | 675 ± 8  | 1718 ± 32                | 1720 ± 17              |
| stricli-routes     | 68 ± 1      | 399 ± 6  | 865 ± 18                 | 738 ± 16               |
| typescript-program | —           | 449 ± 7  | 975 ± 17                 | 755 ± 13               |

Typepeek is slower than these fixed retrieval strategies in this sample. Its value must come from reducing the agent’s discovery work or improving answer quality; the autonomous runs test that question. The correctness fix also adds cost: Execa’s invocation inspection rose from about 874 ms with incorrect evidence to 1,714 ms with correct evidence. This before/after comparison is descriptive, because the harness changed between those runs.

The primed condition enables best-effort persistent reuse, but does not prove a hit. Several workloads remain close to their cache-bypassed times. No timing outliers were removed. The [complete local result](local-retrieval-post-fix.json) records artifact `054536d641956a70fe0da8108d8af84e34548953f60e215692f781e4701e85a4`, built from merged commit `027fc3ab03ca12c05d8fe62d31b6544ccf7fc193`. Packing finished before any observation started.

## Repeatability and regression tolerance

Two independent runs of the Execa command-parser workload used the same packaged artifact and unchanged inputs, with 15 measured repetitions per method after two warmups. All 120 observations were correct. Both runs met the 20% CV limit; the largest observed CV was 5.1%. Every median stayed within about 1.2% of its baseline and passed the prespecified `max(10%, 10 ms)` tolerance.

| Method        | Baseline median, ms | Current median, ms | Allowed increase, ms | Gate |
| ------------- | ------------------- | ------------------ | -------------------- | ---- |
| files         | 68.4                | 68.1               | 10.0                 | pass |
| compiler      | 408.9               | 404.2              | 40.9                 | pass |
| typepeek-cold | 959.7               | 963.4              | 96.0                 | pass |
| typepeek-warm | 968.1               | 964.7              | 96.8                 | pass |

The [baseline](tolerance-baseline.json) and [comparison](tolerance-current.json) retain every observation, the compatibility checks, and the gate outcome. This demonstrates repeatability for one workload on this machine. It does not establish a universal tolerance for shared CI runners, different packages, or live models. The gate would reject incompatible inputs, incorrect evidence, unstable runs, or a median increase beyond the configured allowance.

## Defects exposed by the benchmarks

The packaged CLI could report an array return as `{}`, erase Execa's rest-argument array from exact signature text, or report its `string | URL` parameter as `any`. Signature and Export Inspections now load the standard-library declarations needed by the checker. Signature Inspection also selects the installed Node Declaration Provider when the selected export references it. The separate fix includes a cache-identity change and regressions through the packaged CLI and Inspection Protocol.

The product fixes were merged in [PR #63](https://github.com/ueberBrot/typepeek/pull/63), commit `027fc3ab03ca12c05d8fe62d31b6544ccf7fc193`. Standard-library paths also needed a Windows comparison fix. All eight CI jobs passed before merge. Loading complete declarations adds compiler work; Execa’s proof now exceeds the optional cache’s 64 KiB limit, so those inspections run uncached.

The benchmark itself also needed corrections: consumer-relative Node declaration resolution in the independent oracle, optional trailing-comma normalization, and deduplication of identical ESM/CJS declaration interfaces. The duplicated interfaces were collapsed as complete units, preserving actual overloads within each file. Saved results identify any regrading; measured times and usage were retained.

## Earlier runs and interpretation limits

The [interrupted post-fix campaign](codex-post-fix-interrupted.json) retained 19 completed attempts with 875,618 reported input-plus-output tokens. A twentieth attempt has launch artifacts but no saved answer or usage; its cost is unknown. These unbalanced observations are diagnostic only. A commit hook also ran local checks during one recorded Stricli trial; the archive preserves that deviation. A fresh, balanced three-condition campaign replaces this partial study and the proposed supplemental pair.

The [external-directory run](codex-external-node-modules.json) placed the physical dependency tree outside the consumer. That fixture caused unsupported declaration-provenance results and was replaced with an ordinary installation inside the consumer. Its 30 attempts are diagnostic data, not the normal-installation comparison. Regrading corrected two formatting-only Stricli failures: files-only finished at 12/15 correct and Typepeek at 14/15. The archived result preserves the original grades and the reason for each change.

Earlier local calibration runs remain under `.benchmarks/`: a two-attempt pilot used 79,969 reported tokens, and an 18-attempt three-task calibration used 850,140. The external-directory study used 1,699,709; the normal-installation pre-fix study used 1,534,416. Those four runs consumed 4,164,234 reported input-plus-output tokens. Including the interrupted post-fix campaign, the 90-attempt main study (3,636,741 known tokens), and the separate repeat (94,306), known usage across these experiments is 8,770,899 tokens. Two interrupted attempts have unknown usage, so this is a lower bound. The experiments are not pooled into the main quality or timing estimates. Token totals do not establish subscription charges.

The machine was an Apple M1 Max running macOS Darwin 25.6.0, Node 24.18.0, ripgrep 15.2.0, and Codex CLI 0.153.4. The effective inspection compiler was TypeScript 6.0.3 through the `@typescript/typescript6` 6.0.2 compatibility package. Package versions and content hashes are recorded in each artifact. OS caches were warm; Typepeek's persistent cache was bypassed for agent trials.

Fixtures, scheduling, grading, and statistics are deterministic. Model output, service latency, prompt caching, and wall-clock samples are not. The automatic grader verifies the final interface and requires at least one recorded command; proving that a command supplied supporting evidence requires trace review. Two models were measured at low effort; other effort levels remain untested. The [broader research design](../../agent-discovery-analysis.md) proposes more tasks, models, held-out packages, evidence checks, and task-clustered inference.

See the [Codex guide](../../codex-discovery/README.md) and [local retrieval guide](../../discovery/README.md) to reproduce the runs. Pack separately before either benchmark. The [compiler-backend note](../../compiler-backends.md) explains why these measurements cannot be scaled by a projected TypeScript 7.1 compiler speedup.
