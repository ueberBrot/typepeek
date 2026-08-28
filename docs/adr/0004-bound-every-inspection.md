# Bound every inspection

Every inspection is bounded in work, memory, traversal, and output. Exceeding a budget returns `limit-exceeded` with the exhausted Budget Dimension; partial, malformed, truncated, timed-out, or terminated analysis is never authoritative Installed Evidence. Inspection Protocol responses also carry a stable Failure Reason so callers never parse the explanatory message.

Subprocess isolation is specified in [ADR-0006](0006-isolate-each-inspection-in-a-subprocess.md). Cache authority is specified in [ADR-0007](0007-keep-the-inspection-cache-non-authoritative.md). The current thresholds and accounting rules live in the [Inspection budget policy](../reference/inspection-budget-policy.md).

## Inspection Plans

An Inspection Plan is one normalized request and one subprocess. It contains at most 16 ordered queries for one Specifier and Access Style. The subprocess selects one Declaration Provider and evaluates every query against the shared Installed Evidence.

The subprocess materializes one bounded TypeScript program when any query needs declaration evidence. A plan containing only Public Subpath Discovery queries remains manifest-only. Compiler, traversal, result-construction, protocol, and transport limits are aggregate plan budgets.

At the parent seam, an own-data snapshot removes inherited behavior before the same strict Effect Schema validates plan and atomic outcomes. Optional output fields use exact optional-key schemas. Explicit `undefined` therefore cannot cross the process seam when the inferred public type requires omission.

Any query failure or aggregate exhaustion fails the complete plan. Partial results never cross the process seam.

## Public Interface Comparisons

A Public Interface Comparison owns exactly two independent normalized Interface Overview requests. Each side retains its own Resolution Context, Specifier, Access Style, Installed Evidence identity, cache decision, and isolated subprocess. Neither side's Resolution Variant is merged into the other.

Both requests must succeed before the parent constructs one directional index delta under the ordinary aggregate result-construction budget. A failure on either side fails the comparison without exposing a partial comparison.
