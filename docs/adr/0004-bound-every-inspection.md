# Bound every inspection

Every inspection is bounded in work, memory, traversal, and output. Exceeding a budget returns `limit-exceeded` with the exhausted Budget Dimension; malformed, silently truncated, timed-out, or terminated analysis is never authoritative Installed Evidence. A requested Export Page is complete for its explicit page scope. Inspection Protocol responses also carry a stable Failure Reason so callers never parse the explanatory message.

Subprocess isolation is specified in [ADR-0006](0006-isolate-each-inspection-in-a-subprocess.md). Cache authority is specified in [ADR-0007](0007-keep-the-inspection-cache-non-authoritative.md). The current thresholds and accounting rules live in the [Inspection budget policy](../reference/inspection-budget-policy.md).

## Export Pages

An Interface Overview without a cursor returns the complete bounded index or fails. A cursor opts into Export Pages: `start` selects the first page, and the result supplies an opaque continuation cursor when names remain. Each page includes `totalModuleExports`; `complete` is true only when that single page contains the entire index. Absence of `nextCursor` ends traversal and does not make a later page a complete index.

Continuation binds to the Resolution Context, selected declaration authority and identity, Specifier, Access Style, and sorted export-name index. A changed index or mismatched target returns `invalid-request`; callers restart with `start`. The cursor describes the name index, not a snapshot of every exported declaration. Focused queries always inspect their current Installed Evidence.

Paged overview and name-search requests preserve the re-export and declaration-provider validation needed to establish the complete name index, including augmentations. Related focused queries share the coherent compiler program within an Inspection Plan. Explicit pages keep large indexes usable without increasing result transport limits or treating exhausted analysis as a successful page.

## Inspection Plans

An Inspection Plan is one normalized request and one subprocess. It contains at most 16 ordered queries for one Specifier and Access Style. The subprocess selects one Declaration Provider and evaluates every query against the shared Installed Evidence.

The subprocess materializes one bounded TypeScript program when any query needs declaration evidence. A plan containing only Public Subpath Discovery queries remains manifest-only. Compiler, traversal, result-construction, protocol, and transport limits are aggregate plan budgets.

At the parent seam, an own-data snapshot removes inherited behavior before the same strict Effect Schema validates plan and atomic outcomes. Optional output fields use exact optional-key schemas. Explicit `undefined` therefore cannot cross the process seam when the inferred public type requires omission.

Any query failure or aggregate exhaustion fails the complete plan. Partial results never cross the process seam.

## Public Interface Comparisons

A Public Interface Comparison owns exactly two independent normalized Interface Overview requests. Each side retains its own Resolution Context, Specifier, Access Style, Installed Evidence identity, cache decision, and isolated subprocess. Neither side's Resolution Variant is merged into the other.

Both requests must succeed before the parent constructs one directional index delta under the ordinary aggregate result-construction budget. Comparison targets cannot carry cursors and must return complete indexes. A failure on either side fails the comparison without exposing a partial comparison.
