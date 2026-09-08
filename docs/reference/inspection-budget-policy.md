# Inspection budget policy

Typepeek applies the following defensive thresholds to every inspection:

| Area                                            | Bound                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Request / result construction / stdout / stderr | 16 / 60 / 64 / 64 KiB                                                                                       |
| Inspection Plan                                 | 1 through 16 ordered queries; all-or-nothing result                                                         |
| Public Interface Comparison                     | exactly 2 bounded Interface Overviews; all-or-nothing delta                                                 |
| Terminal / JSON adapter output                  | 128 / 128 KiB                                                                                               |
| Compiler host                                   | 50,000 operations; 8 MiB resolution reads; 384 files; 8 MiB source                                          |
| Trusted standard-library catalog                | 128 files; 4 MiB source; 20,000 global names                                                                |
| Manifests                                       | 256 KiB each                                                                                                |
| Package search / export targets                 | depth 64; 1,024 targets at depth 32                                                                         |
| Public Subpaths / candidates                    | 512; 4,096 at depth 64                                                                                      |
| Module Exports / merged declarations            | 320; 128, with 64 KiB per declaration                                                                       |
| Export Search candidates / matches              | 4,096 / 320                                                                                                 |
| Member Discovery candidates / matches           | 4,096 space entries / 256 distinct public names                                                             |
| Namespaces                                      | 128 members at depth 8                                                                                      |
| Signatures                                      | 64; serialized 16 KiB each / 48 KiB total; 256 params / 64 type params                                      |
| Member path                                     | 16 non-empty names, optionally qualified by space; 256 name bytes each; at most 3 direct space lookups each |
| Supporting Types                                | 96 at depth 12                                                                                              |
| Syntax / inferred / declaration-graph traversal | 20,000 / 4,096 / 250,000 nodes; depth 64 / 64 / 256                                                         |
| Aggregate result / Package Documentation        | 4,096 nodes / 16 KiB                                                                                        |
| Untrusted protocol graph validation             | 4,096 objects / 16,384 queued values                                                                        |
| Untrusted cache IPC graph                       | 4,096 objects / 32,768 serialized values / 4 KiB per string                                                 |
| Installed Evidence Proof                        | 512 files; 512 directories / 4,096 entries; 1,024 probes; 64 KiB                                            |
| Inspection cache                                | 12 MiB reads; 96 KiB IPC receipt; 160 KiB entry; 256 entries                                                |

Failed lookups, directory entries, containers, and rendered fragments consume these aggregate budgets. Hostile breadth therefore fails deterministically before elapsed time, memory, or final transport becomes the only guard.

Member Discovery counts candidates in each declaration space and namespace re-export traversal against one shared 4,096-entry budget across an Inspection Plan. Exact Member Inspection shares this budget when a namespace lookup requires re-export traversal. The discovery result's `totalMembers` counts distinct public names before filtering. Each discovery query returns at most 256 names; the plan also shares the ordinary aggregate result-construction budget.

A public name that cannot form a bounded exact Member Path, including a symbol-keyed member, produces `unsupported-evidence` instead of an unusable selector. Discovery also fails explicitly for synthetic public members without declaration evidence. At the maximum path depth, discovery can return an empty leaf but cannot return children that require a longer path. Member queries load the trusted standard library to resolve inherited types; inspecting a library-only declaration still requires Installed Evidence provenance and can return `unsupported-evidence`.

These thresholds come from adversarial fixtures and supported package matrices. They are not a latency, capacity, or compatibility SLA. Unchanged Installed Evidence must produce the same complete result or the same explicit limit outcome independent of timing. Thresholds may change when supported installations justify it.

`INSPECTION_BUDGET_POLICY.identity` is the single cache identity for this complete policy and must change whenever a threshold or accounting rule changes. Storage schema and cache-semantics versions are separate migration identities; they change only with their respective implementation contracts.
