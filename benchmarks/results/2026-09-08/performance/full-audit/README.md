# Full inspection performance audit

Typepeek’s cold CLI latency fell by **17.5–26.2% across ten workloads** compared with the first performance fixes. All 175 observations in each full matrix returned correct facts; all 100 final Typepeek observations preserved the expected answers. The independent compiler query remains faster on every workload.

For example, inspecting the exported `execa` function in the installed `execa` package now takes **1,130 ± 37 ms**, down from **1,376 ± 30 ms** at the start of this audit. The original implementation took 1,672 ± 55 ms in the earlier seven-repetition study. That is a 17.9% reduction during this audit and approximately 32% across both investigations, measured in separate runs.

Here, Execa is the package being inspected. Execa also launches Typepeek’s worker process, but these changes fix Typepeek’s own startup and evidence handling; they do not modify Execa’s process-launching implementation.

## Workload results

Each value is a mean over five fresh processes. “Warm” enables a primed persistent cache; it does not imply a cache hit. The JSON archives include every sample, confidence interval, correctness verdict, artifact hash, and machine identity.

| Installed package → export or search        | Cold before → after | Cold reduction | Warm before → after |
| ------------------------------------------- | ------------------: | -------------: | ------------------: |
| `execa` → `parseCommandString`              |        897 → 664 ms |          25.9% |        893 → 670 ms |
| `execa` → `getCancelSignal`                 |        962 → 778 ms |          19.2% |        972 → 797 ms |
| `execa` → `execa`                           |    1,376 → 1,130 ms |          17.9% |    1,362 → 1,118 ms |
| `execa` → search `error`                    |    1,258 → 1,033 ms |          17.8% |    1,256 → 1,026 ms |
| `execa` → search absent name                |    1,287 → 1,005 ms |          21.9% |    1,271 → 1,006 ms |
| `node:fs` → `readFile`                      |      1,171 → 914 ms |          21.9% |      1,156 → 914 ms |
| `node:fs` → `existsSync`                    |      1,154 → 883 ms |          23.4% |      1,147 → 887 ms |
| `effect/Option` → `getOrNull`               |    1,449 → 1,195 ms |          17.5% |    1,447 → 1,181 ms |
| `@stricli/core` → `buildRouteMap`           |        832 → 615 ms |          26.1% |        699 → 492 ms |
| `@typescript/typescript6` → `createProgram` |        932 → 688 ms |          26.2% |        707 → 494 ms |

The complete final matrix has **no median regressions** under the configured tolerance. Its overall timing gate nevertheless failed because the independent compiler control for `execa-errors` had 23.3% variation, above the 20% limit. Every Typepeek row was stable. The [separate seven-repetition recheck](audit-execa-errors-recheck.json) passed correctness and stability for all three methods: compiler 404 ± 10 ms, Typepeek cold 991 ± 10 ms, and warm 989 ± 6 ms. The noisy original remains in [the full matrix](full-audit-after.json); it is neither replaced nor pooled with the recheck.

## What changed

```diff
 CLI startup
-  Import Effect's complete entry point
-  Initialize TypeScript in both parent and worker
+  Import only the Effect modules Typepeek uses
+  Initialize TypeScript in the packaged worker

 Optional cache-proof recording
-  Record and sort all evidence, then discover that the proof exceeds 64 KiB
+  Stop recording when the proof can no longer fit the same 64 KiB limit
   Continue the complete inspection under the original resource limits
```

**Startup.** Both processes imported Effect’s top-level module. Direct subpath imports avoid initializing unused modules. The parent also imported compiler-dependent cache lookup code and read `ts.version` while constructing the cache codec. Cache storage and parent-side receipt validation now live separately from compiler-dependent identity creation and proof replay. The build embeds the actual compiler runtime version for parent-side validation; the worker still supplies its actual runtime version. A mismatch produces a cache miss.

A regression check blocks TypeScript imports in the parent while requiring a real packaged signature inspection to succeed. It runs against both build outputs. Existing cache tests still enforce identity, authentication, complete outcome validation, and proof replay.

**Oversized proofs.** Optional cache recording continued after the proof had become too large to serialize. The recorder now accounts for exact UTF-8 JSON bytes as unique entries are added. Repeated observations do not consume the budget again. Final strict schema validation remains in place. Tests cover the exact byte limit, mixed file/directory/resolution evidence, Unicode, duplicates, and the absence of further probing after overflow.

The previous path-authorization and bounded-read improvements remain intact. Every compiler filesystem lookup still checks its current lexical and canonical boundary before returning a cached result. No declaration, result, subprocess, or proof limit was increased.

## Profile evidence and remaining costs

Separate sampled profiles cover parent and worker executions for Execa, Node, Effect, Stricli, and TypeScript. Across those cases, parent active sample time fell from approximately 368–375 ms to 163–172 ms. This supports the startup diagnosis; those diagnostic durations are not added to or substituted for ordinary benchmark timings. [Profile summaries and raw-profile hashes](profile-summary.json) retain the evidence. Inclusive function times overlap.

The cache diagnostic explains why several warm results remain close to cold results:

| Inspection                                  | Recorded files | Resolution probes | Original proof bytes | Fits 64 KiB? |
| ------------------------------------------- | -------------: | ----------------: | -------------------: | :----------: |
| `execa` → `execa`                           |            216 |               493 |              230,037 |      No      |
| `node:fs` → `readFile`                      |            182 |               370 |              164,287 |      No      |
| `effect/Option` → `getOrNull`               |            171 |               584 |              334,752 |      No      |
| `@stricli/core` → `buildRouteMap`           |             72 |                 1 |               18,295 |     Yes      |
| `@typescript/typescript6` → `createProgram` |             74 |                 2 |               19,410 |     Yes      |

These counts came from a diagnostic copy of the packaged worker before early termination was implemented. They show how much optional recording was discarded. The original [diagnostic output](audit-proof-diagnostic.json) is retained. Large proofs still cause misses; early termination saves work without introducing partial cache authority. Compact proof encoding could improve reuse, but would require a separately validated representation and bounded decoding.

Compiler parsing, type checking, Node declaration-provider selection, and fresh filesystem authorization remain substantial costs. A broader compiler-resolution cache was not introduced: skipping host callbacks also skips their current boundary checks unless equivalent validation is designed into the cache. The existing independently terminable worker, 192 MiB heap, and 10-second deadline remain part of the inspection contract.

## Experiments retained and rejected

Each intermediate experiment used five repetitions and one warmup for the Execa invocation workload. They were sequential experiments, not randomized assignments of implementations.

| Artifact                                                                        | Cold mean ± 95% CI | Disposition                  |
| ------------------------------------------------------------------------------- | -----------------: | ---------------------------- |
| [Narrow Effect imports](audit-effect-imports.json)                              |      1,309 ± 19 ms | Retained                     |
| [Compiler removed from packaged parent](audit-parent-compiler-valid.json)       |      1,195 ± 72 ms | Retained                     |
| [Early proof-size accounting](audit-proof-budget.json)                          |      1,103 ± 23 ms | Retained                     |
| [Standard-library scanner allocation changes](audit-standard-library-scan.json) |      1,104 ± 15 ms | Reverted: no measurable gain |

An earlier compiler-metadata attempt incorrectly used the package manifest version. The installed package says 6.0.2 while its runtime reports 6.0.3. Cache tests caught the mismatch. Its [measurements](audit-parent-compiler.json) remain archived but are excluded from gain claims because cache creation was disabled. The final implementation embeds the actual runtime version. The earlier native-path-resolution experiment also remains rejected in the parent report.

## Reproduction and limits

Both full matrices used Node 24.18.0 on the same Apple M1 Max, the same installed dependency contents, the same consumer path, seed 1729, and one warmup. Packing happened before timing. The host was kept awake. Builds, tests, and other heavy local work were excluded from measurement periods; code reviews were read-only.

Start the first command from commit `de95966`; apply the candidate before the second measurement.

```bash
vp run pack
caffeinate -i node benchmarks/discovery/run.ts --iterations 5 --warmups 1 \
  --output .benchmarks/performance/full-audit-before.json --check
# Apply and pack the candidate before starting the next timed run.
caffeinate -i node benchmarks/discovery/run.ts --iterations 5 --warmups 1 \
  --compare .benchmarks/performance/full-audit-before.json \
  --output .benchmarks/performance/full-audit-after.json --check
```

[Before](full-audit-before.json) uses artifact `9d0a1540a30c268a4a85f363463e798168f4e226aad1c978c2162c3ba962ff8f`; [after](full-audit-after.json) uses `8cd6a091ad92f0b4706f36284ac7f34b11489707edf173e9240447eef1e0c8dd`. Their commit field is the common starting commit `de95966`; candidate changes were uncommitted while measured. Artifact hashes distinguish the implementations. OS filesystem caches were not flushed. These results describe one host and these installed graphs, not cross-platform performance or end-to-end agent savings.

## Verification

Standards review: no hard violations or actionable smells. Spec review: no findings against complete results, bounded subprocesses, installed-package authority, or non-authoritative cache reuse. Both reviews inspected the changes without running work alongside timing measurements.

All **564 tests** pass with two workers. Formatting, lint, types, Effect diagnostics, Fallow, both build/package smoke checks, all seven packaged regression gates, and the discovery smoke check pass. The gates measured 426,868,736 bytes of analysis RSS against a 603,979,776-byte limit and a 393,525-byte runtime package against a 524,288-byte limit. No resource limit was increased.

The 90-attempt Luna/Sol study is being repeated with its previous settings. All 90 prompts match the earlier campaign exactly. The prior agent study and four-attempt required-use pilot remain recorded separately; deterministic retrieval gains do not by themselves establish better agent reliability or token efficiency.

## Isolation correction before the agent rerun

An additional native-sandbox probe found that a sibling development checkout under `/private/tmp` was readable, including its grader and archived answers, despite the active checkout passing the old preflight. An explicit denial of that temporary directory also left those files readable on this host. No model request was made during these probes.

The permanent preflight now enumerates registered Git worktrees and tests their grader and source paths, using NUL-delimited path records. It rejected the exposed sibling checkout. That checkout and its archived answers were then moved outside shared temporary directories; the strengthened preflight passed all three conditions. The model prompts, tools, deadlines, and token budgets are unchanged.

The earlier four-attempt pilot checked only its active checkout. Its six recorded commands are all Typepeek invocations, with no observed access to outside answers, but its original isolation check did not exclude the exposed sibling. A retrospective note records this limitation without changing any original command, grade, duration, or token count.
