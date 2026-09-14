# Bound every inspection

Every inspection has work, memory, traversal, and output limits. Exceeding a budget returns `limit-exceeded` with the exhausted Budget Dimension. Malformed, truncated, timed-out, or terminated analysis cannot produce a successful result. An Export Page covers its stated page scope. Protocol responses include a stable Failure Reason for programmatic handling.

Subprocess isolation is specified in [ADR-0006](0006-isolate-each-inspection-in-a-subprocess.md). Cache authority is specified in [ADR-0007](0007-keep-the-inspection-cache-non-authoritative.md). The current thresholds and accounting rules live in the [Inspection budget policy](../reference/inspection-budget-policy.md).

## Export Pages

An Interface Overview without a cursor returns the complete bounded index or fails. A cursor opts into Export Pages: `start` selects the first page, and the result supplies an opaque continuation cursor when names remain. Each page includes `totalModuleExports`; `complete` is true only when that single page contains the entire index. Absence of `nextCursor` ends traversal and does not make a later page a complete index.

Continuation binds to the Resolution Context, selected declaration authority and identity, Specifier, Access Style, and sorted export-name index. A changed index or mismatched target returns `invalid-request`; callers restart with `start`. The cursor describes the name index, not a snapshot of every exported declaration. Focused queries always inspect their current Installed Evidence.

Paged overview and name-search requests validate re-exports and Declaration Providers, including augmentations, before returning names. Related focused queries share one compiler program within an Inspection Plan. Pages use the ordinary result transport limits.

## Inspection Plans

An Inspection Plan is one normalized request and one subprocess. It contains at most 16 ordered queries for one Specifier and Access Style. The subprocess selects one Declaration Provider and evaluates every query against the shared Installed Evidence.

The subprocess materializes one bounded TypeScript program when any query needs declaration evidence. A plan containing only Public Subpath Discovery queries remains manifest-only. Compiler, traversal, result-construction, protocol, and transport limits are aggregate plan budgets.

The parent snapshots own data properties before validating plan and atomic outcomes with the same strict Effect Schema. Optional fields must be omitted when absent; explicit `undefined` is rejected.

Any query failure or aggregate budget exhaustion fails the whole plan, with no partial results.

## Public Interface Comparisons

A Public Interface Comparison runs two independent normalized Interface Overview requests. Each keeps its own Resolution Context, Specifier, Access Style, Installed Evidence identity, cache decision, and subprocess.

Both requests must return complete indexes before the parent constructs the directional delta under the aggregate result budget. Comparison targets cannot carry cursors. A failure on either side fails the whole comparison.
