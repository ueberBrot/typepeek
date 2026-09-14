# Advanced inspection

## Select the target

Use `--workspace <path>` to select a consumer when several workspaces declare the dependency. Select the workspace, not its `node_modules`. A sole matching workspace is selected automatically. Use `--access require` for a `require` call; the default selects import conditions.

## Browse large indexes

Run `overview <specifier> --cursor start --json`. Read `result.moduleExports` and `result.exportPage.totalModuleExports`. Stop when the needed export is found; otherwise pass `nextCursor` unchanged as `--cursor`, keeping the same target and access style.

For exhaustive discovery, collect pages until `nextCursor` is absent. `complete` describes the current page and can remain false on the final page. If a cursor is rejected, discard collected pages and restart. Inspect selected exports for details.

## Discover subpaths and members

Use `subpaths <specifier>` for public package entrypoints. Use `members <specifier> <export> [member-path]` to discover immediate members, optionally narrowed by `--match <fragment>`. Then use `member <specifier> <export> <member-path>` for declarations.

`totalMembers` counts names before filtering. Empty filtered results mean no name matched; an unfiltered success with zero members identifies a leaf. Discovery includes inherited members, but a standard-library member can still lack installed declaration provenance.

Represent nested paths as `'["shape","keyof"]'`. For an ambiguous segment, use its discovered space: `'[{"name":"shared","space":"type"},"leaf"]'`. Spaces are `type` (instance), `value` (static), and `namespace`. The same paths work in plans. Stop when the selected member's complete declaration answers the question.

## Combine known queries

Use `plan <specifier> '<queries-json>' --json` when every query is already known and must share one evidence snapshot. Read capabilities for query fields. Any query failure fails the entire plan; there is no partial result. For dependent discovery, read the first result before selecting the next query.

## Compare interfaces

Use `compare <before> <after> --before-workspace <path> --after-workspace <path>` for added or removed export names and subpaths. Comparison requires complete indexes. A retained name does not establish unchanged declarations or signatures.
