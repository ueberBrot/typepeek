# Bound every inspection

Every inspection is bounded in work, memory, traversal, and output. Exceeding a budget returns `limit-exceeded` with the exhausted Budget Dimension; partial, malformed, truncated, timed-out, or terminated analysis is never authoritative Installed Evidence. Inspection Protocol responses also carry a stable Failure Reason so callers never parse the explanatory message.

## Isolation

Inspection Core starts one execa-managed Node subprocess per normalized request. It accepts one JSON result over byte-limited stdout only after exit code zero. The parent enforces a 10-second deadline, 100-millisecond kill escalation, 128 MiB old-generation heap, and 4 MiB stack. A process, rather than a worker thread, provides independent termination and startup-time memory enforcement.

An Inspection Plan is still one normalized request and one subprocess. It contains at most 16 ordered queries for one Specifier and Access Style. The subprocess selects one Declaration Provider and evaluates every query against that shared Installed Evidence. It materializes one bounded TypeScript program when any query needs declaration evidence; a plan containing only Public Subpath Discovery queries remains manifest-only. Compiler, traversal, result-construction, protocol, and transport limits are aggregate plan budgets. Any query failure or aggregate exhaustion fails the complete plan; partial results never cross the process boundary.

A Public Interface Comparison owns exactly two independent normalized Interface Overview requests. Each side retains its own Resolution Context, Specifier, Access Style, Installed Evidence identity, cache decision, and isolated subprocess; neither side's Resolution Variant is merged into the other. Both must succeed before the parent constructs one directional index delta under the ordinary aggregate result-construction budget. A failure on either side fails the comparison without exposing a partial comparison.

## Budgets

| Area                                            | Bound                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| Request / result construction / stdout / stderr | 16 / 60 / 64 / 64 KiB                                                  |
| Inspection Plan                                 | 1 through 16 ordered queries; all-or-nothing result                    |
| Public Interface Comparison                     | exactly 2 bounded Interface Overviews; all-or-nothing delta            |
| Terminal / JSON adapter output                  | 128 / 128 KiB                                                          |
| Compiler host                                   | 50,000 operations; 8 MiB resolution reads; 384 files; 4 MiB source     |
| Trusted standard-library catalog                | 128 files; 4 MiB source; 20,000 global names                           |
| Manifests                                       | 256 KiB each                                                           |
| Package search / export targets                 | depth 64; 1,024 targets at depth 32                                    |
| Public Subpaths / candidates                    | 512; 4,096 at depth 64                                                 |
| Module Exports / merged declarations            | 320; 128, with 64 KiB per declaration                                  |
| Export Search candidates / matches              | 4,096 / 320                                                            |
| Namespaces                                      | 128 members at depth 8                                                 |
| Signatures                                      | 64; serialized 16 KiB each / 48 KiB total; 256 params / 64 type params |
| Member path                                     | 16 non-empty segments; 256 bytes each; 3 direct space lookups each     |
| Supporting Types                                | 96 at depth 12                                                         |
| Syntax / inferred / declaration-graph traversal | 20,000 / 4,096 / 250,000 nodes; depth 64 / 64 / 256                    |
| Aggregate result / Package Documentation        | 4,096 nodes / 16 KiB                                                   |
| Untrusted protocol graph validation             | 4,096 objects / 16,384 queued values                                   |
| Installed Evidence Proof                        | 512 files; 512 directories / 4,096 entries; 1,024 probes; 64 KiB       |
| Inspection cache                                | 12 MiB reads; 96 KiB IPC receipt; 160 KiB entry; 256 entries           |

Failed lookups, directory entries, containers, and rendered fragments consume these aggregate budgets. This makes hostile breadth fail deterministically before elapsed time, memory, or final transport becomes the only guard.

## Cache authority

The optional persistent cache stores only a successful Inspection Outcome after the parent process has validated it at the same protocol seam as an uncached result. Its identity includes the normalized request, the package-manifest Typepeek version, compiler version, the named budget-policy version, cache semantics, and the canonical Installed Evidence selection. Transport protocol versions do not affect canonical Inspection Outcomes. Changing any cache identity dimension creates a miss.

Automatic persistent reuse is enabled only for packaged builds with an embedded package version. Direct source execution requires an explicit cache directory, and Windows persistence remains disabled until private ownership can be verified rather than assumed.

Each entry also carries an Installed Evidence Proof for every consumed manifest and declaration, every selected module or type-reference resolution, and every traversed Public Subpath directory. Lookup repeats those bounded resolutions, directory fingerprints, and content fingerprints before returning the candidate. Missing wildcard roots are represented by the nearest readable package directory so newly materialized topology also invalidates. A proof that changes, exceeds validation limits, cannot be read, or fails integrity validation is a miss rather than authority.

Cache receipts and entries are byte-limited. The parent writes only after complete outcome validation, publishes by atomic rename inside a private non-symlink directory, and authenticates entries with a per-directory integrity key protected by those directory permissions. Failed, bounded, malformed, partial, timed-out, and terminated analysis is never stored. Cache deletion, corruption, saturation, or write failure can therefore reduce reuse but cannot change an Inspection Outcome.

## Stability

These defensive thresholds come from adversarial fixtures and supported package matrices; they are not a latency, capacity, or compatibility SLA. Unchanged Installed Evidence must produce the same complete result or the same explicit limit outcome independent of timing. Thresholds may change when supported installations justify it.

`INSPECTION_BUDGET_POLICY_VERSION` is the single cache identity for this complete policy and must be bumped whenever any threshold or accounting rule changes. Storage schema and cache-semantics versions are separate migration identities and change only with their respective implementation contracts.
