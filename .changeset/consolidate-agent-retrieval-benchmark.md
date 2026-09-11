---
"typepeek": patch
---

Add `vp run benchmark` to compare files-only agents with agents given Typepeek and its shipped skill. Report retrieval time, evidence-token usage, and per-task success rates.

Replace the standalone discovery timing suite while preserving saved runs for replay. Older traces without task-submission timestamps retain unknown task-to-evidence times.
