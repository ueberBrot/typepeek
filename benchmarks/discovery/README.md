# Installed dependency discovery benchmark

This benchmark measures process startup, discovery, inspection, and returned evidence for a locked consumer project's installed dependencies. It excludes human reading time and model inference. The [autonomous Codex benchmark](../codex-discovery/README.md) measures agent time, tokens, and correctness with and without Typepeek.

Run from the Typepeek repository with the locked dependencies installed. Node, ripgrep, the effective TypeScript compiler version, dependency contents, lockfile, operating system, CPU, and harness are recorded with every result. No package installation, network lookup, dependency execution, or model API call takes place during the benchmark.

```bash
vp run pack
vp run benchmark:discovery
```

Pack Typepeek separately before benchmarking. The benchmark requires the existing `dist/cli.js`, never builds or packs it, and provides no source-execution mode. The task runs 15 measured repetitions after two excluded warmups, prints a table, and saves `.benchmarks/discovery/latest.json` plus `.benchmarks/discovery/latest.json.traces.jsonl`. Vite+ task caching is disabled. The output directory is gitignored.

For a shorter run, or a different installed consumer:

```bash
vp run pack
node benchmarks/discovery/run.ts --case execa-command --iterations 10 --output .benchmarks/discovery/command.json
node benchmarks/discovery/run.ts --workspace /absolute/path/to/consumer --iterations 20 --output .benchmarks/discovery/consumer.json
```

The consumer needs the packages used by the selected workloads. The default suite uses `execa`, `@types/node`, `effect`, `@stricli/core`, and `@typescript/typescript6`. It uses their actual installed versions and records content hashes; manifest ranges are not treated as version pins. Dependency updates require a new baseline. Installation and oracle construction happen outside the timer. The consumer project is not modified.

## Methods and workloads

| Method          | Timed work                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`         | Resolve the installed package boundary, run `rg` for the named function's declarations, and read every matching declaration file. No file path is supplied by the answer key. |
| `compiler`      | Start an independent TypeScript consumer, resolve the Specifier, inspect its public exports, and produce the requested signatures or names.                                   |
| `typepeek-cold` | Start the packaged CLI with persistent cache lookup bypassed.                                                                                                                 |
| `typepeek-warm` | Start the same CLI with a private, primed cache enabled. Actual cache hits are not instrumented in the packaged CLI; reuse remains best-effort.                               |

Declaration graphs that exceed the [cache-proof limits](../../docs/reference/inspection-budget-policy.md) run uncached even in the primed condition. The warm label alone does not establish a cache hit.

Each observation starts a fresh process. “Cold” describes Typepeek's persistent cache only: OS filesystem caches are not flushed. The independent oracle and warmups warm the OS cache for all methods. A seeded, rotating condition order balances the positions in each repeated block. Warmups and the cache-prime call are recorded in the trace but excluded from timings.

Ten workloads cover Execa command parsing, cancellation, overloaded invocation, error-name discovery, an absent export name, Node `readFile` overloads, Node `existsSync`, Effect's generic `getOrNull`, Stricli's generic `buildRouteMap`, and the compiler's re-exported `createProgram`. The search/read replay applies to the five named function declarations it can retrieve without constructing a complete export graph. Other workloads compare the independent compiler against Typepeek. Unsupported replay methods are not counted as successful zero-time results.

The replay is a fixed search strategy for a known name. It does not model an agent deciding which name to search for, following failed hypotheses, reading the returned text, or generating an answer. The compiler baseline uses a purpose-built helper with the target query already known. A retrieval speedup is not a claim about end-to-end agent speed.

## Correctness and evidence

The oracle constructs a real TypeScript consumer with NodeNext resolution and strict checking. Its implementation imports no Typepeek inspection code. Both tools see the same Installed Evidence and effective compiler version. Oracle resolution, grading, report formatting, trace writes, and hashing are outside the measured interval; tool process startup and stdout transfer are inside it.

The grader compares complete signature token sequences in declaration order, or complete sorted export-name matches. It ignores comments, whitespace, quote style, optional leading union/intersection operators, and trailing list commas. It preserves types, overloads, parameter names, optionality, and return types. It does not test semantic equivalence between arbitrary type spellings. The search/read grader parses the retrieved files and keeps the selected ambient module, so `fs/promises` overloads do not count as `node:fs` evidence. It collapses identical complete interfaces repeated across ESM/CJS declaration files, while preserving overloads within a file.

Signature workloads grade exact text. Packaged CLI tests separately check structured fields. Incorrect observations are excluded from speedup comparisons. The [results report](../results/2026-09-08/README.md) identifies measured artifacts and documents the Execa rest-argument defect these checks exposed.

Every measured sample records elapsed milliseconds, stdout bytes, correctness, errors, normalized evidence hash, and operation count. The trace also preserves argv, stdout, stderr, phase, and execution order. Timeouts, process failures, malformed results, and wrong evidence remain in the report. Dependency evidence and the lockfile, CLI artifact, and harness are fingerprinted before and after the run; changes invalidate correctness. No outliers are discarded.

Returned-byte counts describe each method's native evidence. File replay returns source text and its search/read trace; compiler output returns signatures/names and compiler metadata; Typepeek returns its CLI JSON. These are not token counts. The parser in the grader is outside the timer for every method, so a file-replay time is time to retrieve sufficient evidence, not time to understand it.

## Timing uncertainty and regression tolerance

Reports show mean ± a two-sided 95% Student t confidence interval, median, p95, sample standard deviation, and coefficient of variation (CV). The interval estimates uncertainty in the mean under the usual independent-observation assumptions; it is not a promise that each invocation falls within that range. p95 from a small run is descriptive, not a reliable production tail estimate.

Paired speedup is baseline time divided by Typepeek time. Values above 1 favor Typepeek; values below 1 favor the baseline. A fixed-seed bootstrap of whole pairs supplies a 95% interval for the median ratio when at least five observations exist. Use the same samples and seed to reproduce the statistics exactly. Timing observations themselves vary with machine and system load.

To check a saved baseline on the same machine:

```bash
node benchmarks/discovery/run.ts --case execa-command --iterations 15 --output .benchmarks/discovery/baseline.json --check
node benchmarks/discovery/run.ts --case execa-command --iterations 15 --compare .benchmarks/discovery/baseline.json --output .benchmarks/discovery/current.json --tolerance-percent 10 --tolerance-ms 10
```

A regression is a median increase greater than `max(baseline median × 10%, 10 ms)` by default. The gate also requires correct evidence, at least five samples per method, and CV at or below 20% in both runs. An unstable run fails the gate as noisy; it does not silently widen the tolerance or drop slow samples. These thresholds are configurable and are engineering limits, not a statistical significance test. Save multiple independent runs before tightening them for a dedicated runner.

Comparisons reject changes in machine, Node/compiler/ripgrep, installed evidence, lockfile, adapter, harness, scheduling seed, warmup count, timeout, or workload/method coverage. The CLI artifact and Git commit may differ to allow testing a code change. Only the prepacked artifact is executed; historical results from other adapters are incompatible. Archive complete runs, including slow observations.

Run the suite while the machine is idle, on the same power mode and hardware. Do not run builds, other tests, or benchmarks concurrently with measured observations. The ordinary CI test and packaged smoke check validate correctness and harness behavior without enforcing wall-clock thresholds on shared runners. Performance gating belongs on a consistent runner with an explicitly supplied baseline.

```bash
node benchmarks/discovery/run.ts --help
vp test tests/discovery-benchmark.test.ts
```

Correctness failures always return exit code 1. `--check` additionally enforces stability; `--compare` enforces compatibility, stability, and regression tolerances. The separate `node tests/discovery-benchmark-package-smoke.ts` check requires a prepacked artifact and makes no timing-stability claim.

For future backend comparisons, see [TypeScript 7.1 and the native API](../compiler-backends.md).
