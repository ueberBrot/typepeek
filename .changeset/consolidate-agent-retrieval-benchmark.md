---
"typepeek": patch
---

Consolidate benchmarking around agent retrieval with `vp run benchmark`. The default compares files-only agents with agents given the packaged Typepeek CLI and shipped skill. Interleave repeated tasks across Terra, Luna, Sol, and Astra at low and high effort; preview the matrix with `--dry-run`. CLI-only and required-use conditions remain optional diagnostics.

Measure task submission through sufficient returned evidence, including initial strategy selection. Retain first-tool-request timing as a diagnostic, evidence tokens separately from whole-run usage, and timestamped traces for replay. Isolate host configuration and skill instructions across conditions. Old traces without a submission marker retain unknown task-to-evidence time.

Preserve these benchmark safeguards and fixes:

- Use unique output paths by default and refuse to overwrite existing reports or traces.
- Reject selections combining `all` with individual tasks to prevent duplicate trials and ambiguous pairing.
- Retain known token counts from damaged or partial usage logs, keep missing breakdowns unknown, and stop campaigns when missing usage prevents budget accounting.
- Report success rates, per-task results, coverage, and paired successful comparisons. Skip bootstrap resampling when too few paired observations support an interval.
- Recognize declaration evidence in mixed file-search output without joining unrelated line ranges, including contiguous numbered reads across responses. Clarify the agent skill's direct-lookup path and evidence requirements.

Retire the separate local discovery timing suite in favor of packaged-CLI correctness tests over all ten workloads with cache bypassed and enabled. The retired suite had gained selected-workload schema v2, evidence-hash and answer-key validation, complete method/workload coverage checks, suppression of speedups for changed inputs, and distinct unrequested/failed regression-gate reporting. Its saved reports and traces remain untouched; its timing gates and report comparator are no longer maintained. The agent benchmark retains independent evidence grading and run fingerprints.
