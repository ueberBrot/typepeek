# Autonomous Codex dependency discovery

This is the end-to-end comparison: can Codex find a correct installed Public Interface sooner, and with fewer tokens, when Typepeek is available? Both conditions choose their own search strategy. The control can search files, follow re-exports, or write a compiler helper. The treatment has those same choices plus the packaged Typepeek CLI. It may ignore the CLI.

```bash
vp run pack
node benchmarks/codex-discovery/run.ts --prepare-only
node benchmarks/codex-discovery/run.ts --output .benchmarks/codex-study
```

Live Codex studies run manually on an authenticated local machine. CI runs only deterministic tests and packaged CLI checks; it does not install, authenticate, or invoke Codex.

Packaging is an explicit prerequisite. Neither this runner nor `vp run benchmark:codex` builds or packs Typepeek; all treatment calls execute a copy of the existing packaged artifact. Packing is never included in the timer.

The default study runs five tasks across five installed package families, three fresh repetitions, and two conditions using `gpt-5.6-luna` at low effort: 30 model turns. It uses the authenticated local Codex CLI and consumes model usage. Run from the repository with locked dependencies installed. Codex must support native permission profiles; the runner stops if its isolation preflight fails. Nested operating-system sandboxes may require launching the harness outside the outer sandbox; the trial commands still run under the benchmark's restricted profile.

To compare Luna and Sol at low effort, interleave their task pairs in one campaign:

```bash
node benchmarks/codex-discovery/run.ts --models gpt-5.6-luna,gpt-5.6-sol --repeats 3 --total-token-limit 4000000 --output .benchmarks/codex-two-models
```

This schedules 60 attempts. The four-million-token campaign limit is checked between attempts; it is not an estimate of required usage.

To measure the shipped skill's contribution separately from CLI availability:

```bash
node benchmarks/codex-discovery/run.ts --models gpt-5.6-luna,gpt-5.6-sol --efforts low --conditions files,typepeek,typepeek-skill --repeats 3 --total-token-limit 6000000 --output .benchmarks/codex-three-conditions
```

This schedules 90 attempts: five tasks × two models × three conditions × three repetitions. The skill condition supplies the checked-in `skills/typepeek/SKILL.md` verbatim in the task prompt. It measures explicit skill guidance, including its input-token cost; automatic skill discovery and invocation overhead are outside this comparison. CLI use remains the model's choice. Compare skill versus CLI-only as well as both treatments versus files-only, retaining failures and all reported usage.

To test a prescribed Typepeek workflow instead of voluntary adoption:

```bash
caffeinate -i node benchmarks/codex-discovery/run.ts --models gpt-5.6-luna,gpt-5.6-sol --conditions files,typepeek-required --repeats 3 --output .benchmarks/codex-required
```

`typepeek-required` includes the same skill text and requires a successful JSON inspection of the requested module and export before completion. Help output, failed commands, and results for another module do not satisfy this condition. The independent oracle still grades the final answer; a successful tool call cannot excuse missing generics, overloads, or an altered signature. The prompt tells the model to copy the signature's `text` field rather than reconstruct it from parameter metadata. Use this condition to measure a prescribed workflow, and keep it separate from the optional-use adoption study. On platforms without `caffeinate`, run the same command with the host's sleep prevention enabled.

Every study remains a single-turn experiment. Unresolved answers and failures stay in the denominator; the harness does not rerun failures until they pass. A study of recovery would need a separate protocol that records the first-attempt outcome and charges every additional attempt's time and tokens.

For a larger matrix:

```bash
node benchmarks/codex-discovery/run.ts --cases all --models gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-6-astra --efforts low,medium,high --conditions files,typepeek,typepeek-skill --repeats 5 --total-token-limit 2000000 --output .benchmarks/codex-matrix
```

Model access depends on the current account. Unsupported models and authentication failures stop the campaign; they do not count as evidence that Typepeek failed. `--help` lists all options. Matrix size is tasks × models × efforts × conditions × repetitions. The cumulative token limit is checked between attempts and can overshoot by one attempt. A 120-second deadline and a 60,000-token Codex rollout budget apply to each attempt by default. The rollout budget is Codex’s internal accounting, not a hard cap on the summed input/output usage events; repeated cached context can make those totals larger. The rollout feature is experimental; this harness was verified with Codex CLI 0.153.4, whose reminder setting takes an array.

## Fair comparison

Each study copies installed dependencies into one read-only snapshot. The installation is physically inside the consumer directory, preserving repository-relative declaration provenance. Before each sequential trial, the runner removes every consumer file except the read-only installation and recreates the manifest and scratch space. The directory path is reused, while its mutable contents and Codex session are fresh. The sandbox prevents reads of the source repository, grader, prior trial artifacts, and host configuration. Only treatment trials can read and execute the separately copied packaged CLI. Tool commands cannot use the network. Host skills, plugins, MCP servers, agents, project instructions, and persistent Codex sessions are disabled. The `typepeek-skill` and `typepeek-required` conditions explicitly include the checked-in skill text and accounts for its input tokens.

The prompt requires installed evidence and permits any local static inspection strategy. It does not supply the oracle's file paths. Four tasks also withhold the export name and describe the needed capability. Both conditions must return the same JSON answer format. Typepeek's persistent cache is bypassed; OS caches are not flushed. The condition order within each task/repetition pair and the order of pairs use a recorded shuffle seed. This reproduces scheduling, not model generation.

An independent TypeScript consumer supplies the answer key. The grader checks the export and every signature or every matching export name. It preserves overload order, types, parameter names, and optionality, while ignoring formatting trivia. This is an exact-interface benchmark, not a general semantic-equivalence grader. An unresolved, wrong, incomplete, timed-out answer, or one with no recorded command, fails. A recorded command does not itself prove that the answer used installed evidence; review the saved command output before making that claim. A CLI failure can still lead to a passing treatment attempt if Codex recovers through another permitted approach.

## Time and tokens

The timer starts immediately before `codex exec` and ends when the process exits. It includes client startup, model latency, tool calls, retries, and final answer generation. Fixture creation, oracle construction, grading, and artifact writes happen outside the timer. Run studies sequentially while the machine is otherwise idle.

Keep the host awake during measurement. On macOS, prefix the runner command with `caffeinate -i` to prevent idle sleep for its lifetime. Host suspension can delay the process timeout and leave final usage unavailable. Preserve such attempts, document the interruption, and report any block exclusion or supplemental repetition separately; do not silently replace the original observations.

Every trial saves its prompt, launch settings, JSONL events, stderr, final answer, and grade. `summary.json` includes individual attempts and grouped results; `summary.md` presents the main table. Machine, Node/compiler/Codex versions, dependency evidence, lockfile, CLI artifact, harness, and skill hashes identify the inputs. Raw artifacts are local and gitignored. Explicit output directories must be empty; the default creates a timestamped subdirectory so later runs do not overwrite earlier evidence.

Token counts come from Codex's `turn.completed.usage` events:

- Input tokens include cached input; cached input is also shown separately.
- Output tokens include any reasoning tokens. A separate reasoning count is recorded only when Codex supplies it and is never added twice.
- Total tokens are input plus output. Tokens per correct answer divide the total across **all attempts, including failures**, by the number of correct answers. Infrastructure failures are counted separately and excluded from task-quality denominators, while their known usage stays in token totals. A timed-out attempt remains a task failure.
- Missing usage remains unknown. An interrupted turn may omit its final usage event; the runner then withholds tokens per correct answer for that group. Reported totals are lower bounds when any usage is missing.

Token counts measure model work, not subscription charges. The provider may reuse prompt caches across fresh sessions; cached input is reported, not assumed to be zero. Service latency and model generation are nondeterministic. The deterministic parts are the fixture, questions, grader, scheduling, and calculations.

Time summaries include successful and all-attempt observations, success within 30/60/120 seconds, and mean ± a 95% Student t interval. Paired comparisons use only cases both conditions answered correctly and report control/treatment ratios for time and total tokens. Ratios above 1 favor treatment. A seeded bootstrap interval is available with at least five successful pairs. These intervals describe run-level variability within the fixed workload set. Repetitions are not independent samples of packages; the intervals do not estimate uncertainty across tasks or packages. The broader study in the analysis document calls for task-clustered inference before making such claims. Report correctness and tokens per correct answer alongside these ratios so failures cannot disappear behind a fast subset. Small studies are exploratory and do not establish a general speedup.

The [local retrieval benchmark](../discovery/README.md) provides repeatable process measurements and an explicit regression gate, with a default median tolerance of `max(10%, 10 ms)`. That gate is separate from live-model variability. The [experiment analysis](../agent-discovery-analysis.md) explains the broader research design.

The default package set is Execa (`execa-command`), Node’s declaration provider (`node-exists`), Effect (`effect-option`), Stricli (`stricli-routes`), and TypeScript’s compatibility API (`typescript-program`). The report includes per-task results so the aggregate cannot hide package differences. See [compiler backend interpretation](../compiler-backends.md) before projecting these results onto TypeScript 7.1’s native API.
