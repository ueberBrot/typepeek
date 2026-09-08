# Dependency discovery measurements, 2026-09-08

These runs compare autonomous Codex with and without the packaged Typepeek CLI. Both conditions could choose their own static inspection strategy. Each model uses five installed package families, three fresh repetitions, and two conditions: 30 attempts. The pre-fix study used `gpt-5.6-luna` at low effort.

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

The [external-directory run](codex-external-node-modules.json) placed the physical dependency tree outside the consumer. That fixture caused unsupported declaration-provenance results and was replaced with an ordinary installation inside the consumer. Its 30 attempts are diagnostic data, not the normal-installation comparison. Regrading corrected two formatting-only Stricli failures: files-only finished at 12/15 correct and Typepeek at 14/15. The archived result preserves the original grades and the reason for each change.

Earlier local calibration runs remain under `.benchmarks/`: a two-attempt pilot used 79,969 reported tokens, and an 18-attempt three-task calibration used 850,140. The external-directory study used 1,699,709; the normal-installation pre-fix study used 1,534,416. Those four runs consumed 4,164,234 reported input-plus-output tokens. They are separate experiments and are not pooled into the main quality or timing estimates. Token totals do not establish subscription charges.

The machine was an Apple M1 Max running macOS Darwin 25.6.0, Node 24.18.0, ripgrep 15.2.0, and Codex CLI 0.153.4. The effective inspection compiler was TypeScript 6.0.3 through the `@typescript/typescript6` 6.0.2 compatibility package. Package versions and content hashes are recorded in each artifact. OS caches were warm; Typepeek's persistent cache was bypassed for agent trials.

Fixtures, scheduling, grading, and statistics are deterministic. Model output, service latency, prompt caching, and wall-clock samples are not. The automatic grader verifies the final interface and requires at least one recorded command; proving that a command supplied supporting evidence requires trace review. Only one model/effort setting was measured. The [broader research design](../../agent-discovery-analysis.md) proposes more tasks, models, held-out packages, evidence checks, and task-clustered inference.

See the [Codex guide](../../codex-discovery/README.md) and [local retrieval guide](../../discovery/README.md) to reproduce the runs. Pack separately before either benchmark. The [compiler-backend note](../../compiler-backends.md) explains why these measurements cannot be scaled by a projected TypeScript 7.1 compiler speedup.
