# Inspection budget policy

Typepeek applies the following defensive thresholds to every inspection:

| Area                                            | Bound                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Request / result construction / stdout / stderr | 16 / 60 / 64 / 64 KiB                                                                                       |
| Inspection Plan                                 | 1 through 16 ordered queries; all-or-nothing result                                                         |
| Public Interface Comparison                     | exactly 2 bounded Interface Overviews; all-or-nothing delta                                                 |
| Terminal / JSON adapter output                  | 128 / 128 KiB                                                                                               |
| Compiler host                                   | 150,000 operations; 8 MiB resolution reads; 2,048 files; 16 MiB source                                      |
| Trusted standard-library catalog                | 128 files; 4 MiB source; 20,000 global names                                                                |
| Manifests                                       | 256 KiB each                                                                                                |
| Package search / export targets                 | depth 64; 1,024 targets at depth 32                                                                         |
| Public Subpaths / candidates                    | 512; 4,096 at depth 64                                                                                      |
| Module Exports / merged declarations            | 320; 128, with 64 KiB per declaration                                                                       |
| Export Search candidates / matches              | 16,384 / 320                                                                                                |
| Member Discovery candidates / matches           | 4,096 space entries / 256 distinct public names                                                             |
| Namespaces                                      | 128 members at depth 8                                                                                      |
| Signatures                                      | 64; serialized 16 KiB each / 48 KiB total; 256 params / 64 type params                                      |
| Member path                                     | 16 non-empty names, optionally qualified by space; 256 name bytes each; at most 3 direct space lookups each |
| Supporting Types                                | 96 at depth 12                                                                                              |
| Syntax / inferred / declaration-graph traversal | 20,000 / 4,096 / 500,000 nodes; depth 64 / 64 / 256                                                         |
| Aggregate result / Package Documentation        | 4,096 nodes / 16 KiB                                                                                        |
| Untrusted protocol graph validation             | 4,096 objects / 16,384 queued values                                                                        |
| Untrusted cache IPC graph                       | 69,632 objects / 294,912 serialized values / 4 KiB per string                                               |
| Installed Evidence Proof                        | 3,072 files; 2,048 file checks; 512 dirs / 4,096 entries; 16,384 probes; 1 MiB encoded / 8 MiB expanded     |
| Inspection cache                                | 24 MiB replay reads; 1,056 KiB IPC receipt; 1,128 KiB entry; 256 entries                                    |

Export Pages examine at most 16,384 names and return at most 100. They share the ordinary result and transport budgets, including in Inspection Plans. The cursor is an opaque bounded string; it preserves the target and name-index identity across requests.

Compiler resolution caches remain private to one program host and partition results by authorized roots, containing directory, specifier, and resolution mode. Dependency authorization and evidence observation still apply on cache hits. The larger source and proof allowances are exercised by the pinned AWS S3 and EC2 fixtures; compact cache transport remains separate from result stdout.

Failed lookups, directory entries, containers, and rendered fragments consume these aggregate budgets. Public Subpath patterns sharing a search root reuse one bounded directory traversal within an inspection. Hostile breadth therefore fails deterministically before elapsed time, memory, or final transport becomes the only guard.

Member Discovery counts candidates in each declaration space and namespace re-export traversal against one shared 4,096-entry budget across an Inspection Plan. Exact Member Inspection shares this budget when a namespace lookup requires re-export traversal. The discovery result's `totalMembers` counts distinct public names before filtering. Each discovery query returns at most 256 names; the plan also shares the ordinary aggregate result-construction budget.

A public name that cannot form a bounded exact Member Path, including a symbol-keyed member, produces `unsupported-evidence` instead of an unusable selector. Discovery also fails explicitly for synthetic public members without declaration evidence. At the maximum path depth, discovery can return an empty leaf but cannot return children that require a longer path. Member queries load the trusted standard library to resolve inherited types; inspecting a library-only declaration still requires Installed Evidence provenance and can return `unsupported-evidence`.

These thresholds come from adversarial fixtures and supported package matrices. They are not a latency, capacity, or compatibility SLA. Unchanged Installed Evidence must produce the same complete result or the same explicit limit outcome independent of timing. Thresholds may change when supported installations justify it.

`INSPECTION_BUDGET_POLICY.identity` is the single cache identity for this complete policy and must change whenever a threshold or accounting rule changes. Storage schema and cache-semantics versions are separate migration identities; they change only with their respective implementation contracts.
