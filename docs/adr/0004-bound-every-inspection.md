# Bound every inspection

Every inspection is bounded in work, memory, traversal, and output. Exceeding a budget returns `limit-exceeded`; partial, malformed, truncated, timed-out, or terminated analysis is never authoritative Installed Evidence.

## Isolation

Inspection Core starts one execa-managed Node subprocess per normalized request. It accepts one JSON result over byte-limited stdout only after exit code zero. The parent enforces a 10-second deadline, 100-millisecond kill escalation, 128 MiB old-generation heap, and 4 MiB stack. A process, rather than a worker thread, provides independent termination and startup-time memory enforcement.

## Budgets

| Area                                                       | Bound                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Request / result construction / stdout / stderr / terminal | 16 / 60 / 64 / 64 / 128 KiB                                        |
| Compiler host                                              | 50,000 operations; 8 MiB resolution reads; 384 files; 4 MiB source |
| Trusted standard-library catalog                           | 128 files; 4 MiB source; 20,000 global names                       |
| Manifests                                                  | 256 KiB each                                                       |
| Package search / export targets                            | depth 64; 1,024 targets at depth 32                                |
| Public Subpaths / candidates                               | 512; 4,096 at depth 64                                             |
| Module Exports / merged declarations                       | 320; 128, with 64 KiB per declaration                              |
| Namespaces                                                 | 128 members at depth 8                                             |
| Overloads                                                  | 64; 16 KiB each and 48 KiB total                                   |
| Supporting Types                                           | 96 at depth 12                                                     |
| Syntax / inferred / declaration-graph traversal            | 20,000 / 4,096 / 250,000 nodes; depth 64 / 64 / 256                |
| Aggregate result / Package Documentation                   | 4,096 nodes / 16 KiB                                               |

Failed lookups, directory entries, containers, and rendered fragments consume these aggregate budgets. This makes hostile breadth fail deterministically before elapsed time, memory, or final transport becomes the only guard.

## Stability

These defensive thresholds come from adversarial fixtures and supported package matrices; they are not a latency, capacity, or compatibility SLA. Unchanged Installed Evidence must produce the same complete result or the same explicit limit outcome independent of timing. Thresholds may change when supported installations justify it.
