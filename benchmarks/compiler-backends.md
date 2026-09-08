# Interpreting results across TypeScript backends

The current Typepeek inspection engine uses the JavaScript TypeScript API through `@typescript/typescript6`. The installed compatibility package is 6.0.2; the compiler it resolves is 6.0.3. The project's installed `typescript` 7.0.2 executable is used for other development tooling. Its presence does not make Typepeek's inspection engine native.

The TypeScript team is building a stable API for the native Go implementation. As checked on 2026-09-08, the [7.1 iteration plan](https://github.com/microsoft/TypeScript/issues/63703) includes stabilizing content-mapper, emit, and language-service APIs. The [7.0 release announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) describes substantial full-build speedups and explains why API-dependent tools still use TypeScript 6. Those build measurements do not predict Typepeek's eventual inspection latency.

Keep three measurements separate:

| Measurement                                                        | What a native backend could change                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh CLI retrieval time, with warm and bypassed persistent caches | Compiler startup, program construction, resolution, querying, and serialization may change. Node startup and the CLI protocol still contribute. |
| End-to-end Codex time to a correct answer                          | Faster tool calls may help, but model inference, request latency, command choice, retries, and answer generation remain.                        |
| Tokens per correct answer                                          | This depends mainly on evidence size, instructions, reasoning, and recovery. A faster compiler alone does not imply fewer tokens.               |

The [local discovery suite](discovery/README.md) isolates retrieval from the [autonomous Codex study](codex-discovery/README.md). Both save compiler and artifact identities. The existing [inspection latency profiler](inspection-latency.ts) can further attribute current engine costs. Do not divide total agent time by an advertised compiler speedup or label a projected result as a measurement.

When a usable native API is integrated, run the same frozen package snapshots, questions, output protocol, model/effort combinations, and correctness rubric against both artifacts. Allow the control agent to use the same available native static-inspection tools: both approaches may benefit. Test public interfaces for parity before comparing speed, and create an explicit backend comparison rather than weakening ordinary same-environment regression checks. Keep separate results for each package and task as well as the aggregate; a large declaration graph may benefit differently from a small entrypoint.

No native API adapter is claimed or simulated by this benchmark. Today's results establish a baseline for the current engine and a way to measure the later migration.
