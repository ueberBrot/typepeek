# Benchmarking agent discovery with Typepeek

Research and proposed experiment, 2026-09-08. Initial repository inspection: `441ea8ce2f305ac84de2521179a925b25e87a843`. The broader thresholds and run sizes below are proposals. Implemented runners now cover [autonomous Codex time and token usage](codex-discovery/README.md) and [deterministic local retrieval](discovery/README.md). The initial study uses a narrower exact-signature/name rubric and the repository's installed dependencies; it does not yet implement every task category proposed here.

Measure whether an agent reaches a correct, version-specific understanding of an installed package's Public Interface faster and at lower cost with Typepeek. The most useful product result would be that a cheaper model with Typepeek matches a stronger model inspecting declarations directly.

There are two separate questions: what Typepeek adds to the **same model and reasoning setting**, and which **model, reasoning setting, and tool combination** offers the best quality for a given time or cost budget.

**What the project already provides.**

The existing [latency benchmark](inspection-latency.ts) measures CLI execution through source, build, and packaged adapters. The [agent protocol benchmark](agent-protocol.ts) checks deterministic payload and recovery workloads; it does not involve a language model. Keep these as inexpensive regression checks, and add a separate agent evaluation.

Reuse the [real-package corpus](../tests/fixtures/real-package-corpus/package.json), its [lockfile](../tests/fixtures/real-package-corpus/package-lock.json), and the installation and compiler-probe patterns in [the corpus helper](../tests/helpers/real-package-corpus.ts). The lockfile currently selects, among others, Execa 10.0.1, React 19.2.8, date-fns 4.4.0, Zod 4.4.3, and Zod 3.25.76 in a legacy workspace. Manifest ranges alone do not identify the tested version.

Use the corpus's actual Installed Evidence, including separate Declaration Providers such as `@types/react`. A task's identity includes its Resolution Context, exact Specifier, Access Style, package version, Declaration Provider version, and compiler configuration. These distinctions follow the project's [domain definitions](../CONTEXT.md).

**Experimental conditions.**

| Condition                        | Agent access                                                                                                        | What it measures                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A: Installed files               | Directory listing, `rg`, bounded file reads, and the same static TypeScript probe facility as B; no Typepeek access | Competent direct dependency inspection                              |
| B: Installed files + CLI         | Everything in A, plus the pinned Typepeek executable and a short command reference                                  | The value of adding the CLI                                         |
| C: Installed files + CLI + skill | Everything in B, plus the exact shipped Typepeek skill                                                              | The additional value of workflow guidance                           |
| D: Memory only, optional         | Task prompt and answer submission only                                                                              | How often models answer from prior knowledge; a diagnostic baseline |

A versus B is the primary comparison. B versus C isolates the skill's contribution. D is useful for familiar packages but is too weak to be the main baseline.

Let B and C choose whether to invoke Typepeek and fall back to files. Count every assigned run in its condition, including runs that never use the CLI; selecting only CLI users would bias the comparison. Record adoption rate separately. A forced-CLI condition can later measure tool-use ability, but does not measure ordinary adoption.

Both primary conditions receive the same question, consumer project, static compiler access, completion schema, output limits, and agent loop. B adds only the executable and its documented command reference; charge those instruction tokens to B. Neither receives the answer key or suggested target command. Do not ask every task as “inspect export X”: include questions where discovering the right Module Export is part of the work.

Install dependencies before timing. Use identical read-only consumer snapshots and a writable scratch directory per run. Install Typepeek in a separate tool location so its own dependencies do not change the consumer's resolution. A must not be able to invoke or read that tool installation. Keep the Typepeek repository, tests, prior transcripts, and grader files outside the agent workspace. Disable network lookup and installation during discovery. Both conditions inspect the same local material without executing dependency code, consistent with [Static Inspection](../docs/adr/0002-keep-inspection-static.md).

**Tasks that expose useful differences.**

Start with 24 development tasks across at least eight package families. Spread them across the following categories; use the [existing corpus questions](../tests/real-package-corpus.test.ts) as seeds, not as the full evaluation set.

| Category                        | Example question                                                                              | Required evidence                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Name discovery                  | Which Execa exports have “Error” in their names?                                              | Complete matching names for the installed entrypoint                     |
| Semantic discovery              | Which Execa export parses a command string into arguments, and how is it called?              | Selected export, valid import, parameter and return types                |
| Overloads and inference         | What return types does the installed `jsonwebtoken.decode` expose for different option forms? | All relevant overload distinctions and type probes                       |
| Supporting Types and members    | What shape does the selected option or callback accept? Can that type be imported directly?   | Required/optional fields, member types, and importability                |
| Public Subpaths                 | Which entrypoint exposes `addDays`, and which candidate paths are public?                     | Manifest boundary plus resolution from the consumer                      |
| Version and workspace selection | Answer the same Zod question from root and legacy workspaces                                  | Correct version, context, and independently verified differences         |
| Resolution variants/providers   | Inspect an import versus require task, or React with its installed `@types/react`             | Correct Access Style and Declaration Provider                            |
| Recovery and negative cases     | A broad inspection exceeds a budget, or a requested export is absent                          | Narrow recovery where possible; accurate absence or limitation otherwise |

For version tasks, first verify that the selected feature actually differs. Two packages having different versions does not guarantee a useful discriminating question. Include type-only exports, re-exports, aliases, generics, overloads, and Supporting Types that are not independently importable. Scope full-inventory questions to manageable entrypoints so answer length does not dominate every run.

Add a separate stress set of fresh synthetic packages with randomized names, unfamiliar declarations, conditional exports, and intentionally absent members. Freeze each generated fixture across paired conditions. These reduce the usefulness of memorized library facts, but report their results separately from real packages.

**Ground truth must be independent of Typepeek.**

Build and review answer keys from installed declarations, manifest exports, and a separately implemented TypeScript consumer probe. Reuse installation helpers where useful, but do not import Typepeek inspection or rendering code into the grader. Sharing the compiler version aligns language semantics; it does not make the oracle independent of compiler bugs. Include human-reviewed fixtures and record that limitation.

Each task should have an agent-visible prompt and a hidden rubric: required facts, forbidden claims, accepted imports, evidence anchors, and positive and negative compile probes. Require a compact structured answer with the selected Specifier/export, package and provider identities, requested type facts, evidence references, and an optional consumer snippet. File evidence can cite paths and line ranges; CLI evidence can cite recorded call IDs and result fields. Verify that cited evidence supports each material claim.

Compilation alone is insufficient. A snippet can compile through `any`, assertions, suppression comments, or by ignoring the requested feature. Reject these evasions, check required behavior at the type level, test invalid inputs as well as valid inputs, and inspect inferred types where assignability is too permissive. Avoid grading signatures by raw string equality: equivalent type spelling and aliases can differ. A single successful invocation also does not prove overload completeness.

Use binary task success as the headline: all required facts correct, no material false claims, valid public imports, and required probes passing. Add fact precision/recall and failure labels for diagnosis. A correct statement that the CLI hit a limit is honest, but it is not a solved answerable task; report safe abstention separately. For deliberately unanswerable tasks, correct abstention can be success. An LLM judge may assist with explanatory prose, but should not determine type correctness.

A local smoke check demonstrates why this matters. The pre-fix packaged CLI returned exact text `(command: string): string[]` for Execa 10.0.0's `parseCommandString`, while `returns.type` was `{}`. The installed declaration at `node_modules/execa/types/methods/command.d.ts` declares `string[]`. Follow-up checks found an erased rest-argument array and a `string | URL` parameter reduced to `any`. The inspection program omitted standard-library or Node declarations needed to resolve those types. A separate product fix restores that evidence, invalidates older cache entries, and checks exact and structured signatures through the packaged CLI. The [results report](results/2026-09-08/README.md) distinguishes measurements made before and after the fix. The repository's Execa 10.0.0 installation also differs from the corpus's Execa 10.0.1.

**Model and reasoning matrix.**

The following candidates and common effort levels are documented as of the research date. Availability to a particular API account still needs a preflight check.

| Model ID                                                                       | Role in the experiment     | Main effort levels      |
| ------------------------------------------------------------------------------ | -------------------------- | ----------------------- |
| [`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna)   | Low-cost candidate         | `low`, `medium`, `high` |
| [`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | Balanced candidate         | `low`, `medium`, `high` |
| [`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol)     | Stronger GPT-5.6 reference | `low`, `medium`, `high` |
| [`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra)     | Flagship reference         | `low`, `medium`, `high` |

Set effort explicitly. The same effort label does not guarantee the same compute or reasoning-token budget across models. Test `none` separately for the GPT-5.6 models; Astra does not support it. Reserve higher efforts for difficult tasks if the initial results justify their cost. The cited pages currently list undated snapshot IDs; record requested and returned IDs and execution dates, and use a dated snapshot only if officially available.

Start the pilot with Luna and Terra at `low` and `medium`. A complete exploratory matrix of four models, three efforts, two conditions, 24 tasks, and three repeats would contain **1,728 runs**. This is a design-space search; the final claim needs a separate held-out comparison. The decision of greatest interest is whether Luna or Terra with Typepeek reaches the success rate of Sol or Astra inspecting files at lower total cost or latency.

**Agent harness and reproducibility.**

Use one small Responses API harness with a bounded local command executor. The executor runs the real packaged CLI through its public process boundary; the main experiment should not call Typepeek's internal functions. Freeze the Typepeek artifact hash, tool descriptions, prompt, model ID, reasoning effort, service tier, compiler, Node and package-manager versions, lockfile, task set, and harness commit.

Every run starts a fresh conversation. Preserve the model's returned items correctly within its tool loop, including reasoning items when required by the API; do not carry conversation state between tasks. If using `previous_response_id`, resend request-level instructions. Keep tool scheduling the same across models, with no subagents or model-specific prompt tuning in the main matrix. Treat a later native coding-agent integration as a separate validation of external usefulness. See [function calling](https://developers.openai.com/api/docs/guides/function-calling) and the [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create). GPT-6 Astra tool calling requires Responses according to [official model guidance](https://developers.openai.com/api/docs/guides/latest-model).

Proposed initial limits are 120 seconds, 20 local tool invocations, and a fixed per-response generation allowance large enough to include reasoning. Set a separate task-level token/cost limit. Count commands inside a batch, not only the wrapper call. Apply the same output cap to corresponding tools in both conditions, mark truncation explicitly, and permit narrower reads. Freeze limits after the pilot; report which limit ended each unsuccessful run. Higher reasoning may consume more of the allowance, which is part of the fixed-budget comparison.

Record each model request, usage response, command, stdout/stderr, exit status, truncation, timestamps, final answer, and grader outcome as a run artifact. Keep infrastructure failures distinct from task failures. Retain failed attempts and their cost when retrying, and apply the same retry policy across conditions.

**Measurements and interpretation.**

| Measure              | Definition and use                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Success rate         | Successful independent runs / valid attempted runs, including task timeouts and agent/tool errors                              |
| Success by deadline  | Fraction of all runs that finish correctly within, for example, 15, 30, 60, and 120 seconds                                    |
| End-to-end latency   | First model request to final answer; include CLI startup, reads, model calls, and retries; report p50/p95 with sample counts   |
| Cost per solved task | Total model cost across successes and failures / number of successes; undefined if there are none                              |
| Token usage          | Total input and output across every request, with cached/write and reasoning details where reported                            |
| Discovery work       | Tool invocations, files read, bytes returned, evidence tokens, and unsuccessful commands                                       |
| Correctness failures | Wrong version/provider, private import, missing overload, invented member, unsupported claim, bad evidence, or unresolved task |

Compare latency among tasks both conditions solve as a secondary paired measure, and label that selected subset. Success-by-deadline prevents a system that gives up quickly from appearing faster. CLI bytes are a useful diagnostic, but byte reduction alone does not prove token, latency, cost, or quality improvement. Repeated tool results can also reappear in later model inputs.

Separate three cache effects: Typepeek's persistent Inspection Cache, operating-system filesystem caches, and API prompt caching. Run the primary test with `TYPEPEEK_CACHE_BYPASS=1`; this disables Typepeek reuse, not OS caching. Randomize and interleave paired runs to reduce machine-load and provider-time effects. Then measure a deployment scenario with a fresh per-session `TYPEPEEK_CACHE_DIRECTORY`, allowing natural reuse inside that session. A deliberately prewarmed cache is a third, explicitly labeled scenario. Never seed a cache with grading answers. See the [existing latency benchmark](inspection-latency.ts) and [cache policy](../docs/adr/0007-keep-the-inspection-cache-non-authoritative.md).

Report actual API cache usage and realized cost. Reasoning tokens are part of output usage, not an additional output charge to add a second time. For the selected models, separate ordinary input, cache reads, cache writes, and output: `ordinary_input = input_tokens - cached_tokens - cache_write_tokens`. Multiply each bucket by its applicable rate, sum across requests, and save the dated price table with results. See [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [pricing](https://developers.openai.com/api/docs/pricing).

Do not infer hidden reasoning from latency or request private reasoning traces: compare the configured effort, reported reasoning-token usage, visible tool choices, and final correctness. Optional reasoning summaries are not full internal reasoning; keep them disabled in the primary comparison or enable them uniformly in a separate diagnostic run. See the [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

For each model/effort pair, estimate B minus A success and paired cost/time differences. Aggregate within tasks first so repeated runs are not treated as unrelated questions. Report package-level results and confidence intervals that respect task/package grouping. More repeats improve run stability; more diverse tasks improve generalization. Keep related version variants together when splitting development and held-out tasks, and reserve some entire package families for evaluation.

Select configurations on a development set and evaluate finalists on an untouched held-out set. A proposed practical target is at least 25% lower cost per solved task or latency, with the lower confidence bound for success change above -2 percentage points. These are decision thresholds to agree and freeze, not existing evidence. A small pilot cannot establish a two-point non-inferiority claim; choose the confirmation sample size from observed variance and paired disagreement rates. An inconclusive result remains inconclusive.

Report the configurations that offer the best tradeoffs among correctness, speed, and cost. This answers both whether Typepeek helps within a model and whether a cheaper model with Typepeek can replace a stronger baseline at comparable quality.

**Staged implementation.**

1. Build the task schema, isolated corpus materialization, hidden compiler-based grader, trace format, and two primary conditions under a proposed `benchmarks/agent-discovery/` directory. Validate the grader against intentionally wrong answers before paying for model runs.
2. Run a small pilot across two models and two reasoning settings: 24 tasks × 2 models × 2 settings × 2 conditions × 3 independent repeats = **576 runs**. Measure spend, task difficulty, failures, and variance before expanding.
3. Use a broader matrix to locate promising configurations, then confirm a small number of comparisons on held-out tasks. Preflight model access and supported settings and estimate the campaign budget from pilot usage. Do not infer cost from run count alone.
4. Add the skill condition, CLI text versus JSON, and protocol `structured`/`exact`/`both` as separate experiments. The [protocol projection](../src/inspection/signature-evidence-projection.ts) changes available evidence; do not pool it with ordinary CLI JSON. Evaluate `plan` and cache reuse after establishing the baseline.
5. Keep deterministic grading and tool checks in ordinary CI. Run model evaluations on demand or on a scheduled budget, saving immutable raw traces and a compact report with model, effort, condition, success interval, success-by-deadline, latency, cost per solved task, and tokens.

The first deliverable should be a trustworthy paired experiment and error analysis. A leaderboard becomes useful once it distinguishes model limitations, tool evidence defects, discovery failures, and genuine savings from Typepeek.
