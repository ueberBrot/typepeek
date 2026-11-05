# typepeek

## 0.5.0

### Minor Changes

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Use the TSRS TypeScript 7.1 beta SDK for static inspection, SDK types, and standard libraries. Keep native compiler resources within each inspection lifecycle and include both compiler and SDK versions in cache identity. Declaration formatting and namespace export order follow the native compiler.

### Patch Changes

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Give authenticated cache reads, deferred writes, and removal one filesystem owner. Preserve per-operation authority checks and authenticate stored payloads before parsing them.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Batch native symbol, signature, and Member type queries with bounded requests. Scope cached results to their checker so separate compiler snapshots retain their own authority.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Consolidate CLI argument normalization, bounded diagnostics, exit classification, and completion behind one runner.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Keep unresolved references, computed names, and inference traversal state within each declaration-authority scan.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Follow explicit ES2026 library references when inspecting inferred types, including Uint8Array.fromHex and Map.getOrInsertComputed.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Use explicit named SDK imports and enforce the namespace-import rule across source, tests, and benchmark tooling.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Give declaration rendering and Supporting Type expansion one owner for provenance, traversal state, and shared Inspection Plan budgets.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Preserve Public Interface types selected by import attributes, including distinct text and byte ambient-module declarations for the same Specifier.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Transfer newly loaded declaration contents as incremental filesystem layers while retaining earlier snapshots for active checker handles.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Give declaration graph validation ownership of its traversal queues, visited declarations, and aggregate budget shared with Node authority selection.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Separate authorized declaration resolution and evidence receipts from native filesystem snapshot construction.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Cache native alias targets per checker and allow 30 seconds for cold inspections of large declaration graphs. This prevents valid AWS SDK export pages, name searches, and Inspection Plans from exhausting the former 10-second deadline.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Keep parsed-manifest caching, shared byte accounting, and evidence observations inside the compiler work session. Package lookup requests observed manifest reads through a smaller interface.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Separate public declaration selection, inferred-type validation, and Member type-query projection into focused modules with shared rules.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Centralize public signature selection, source ordering, and count and byte limits. Keep detailed rendering behind its own operation and preserve the distinct text-only and structured limits.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Separate Public Subpath Discovery from declaration entrypoint selection. Keep wildcard file traversal, search-root caching, and directory receipts behind one bounded operation.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Inspect types inferred from source-phase imports using the native compiler's module-source declarations.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Run project type checking and Effect diagnostics through TSRS, and configure editor tooling to use the pinned native SDK.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Correct the Windows consumer test guard's native compiler pipe allowance, including write permission for the SDK's named pipe. Cover accepted and rejected launches and pipe permissions with portable regression tests.

  Keep compiler pipe paths literal during guard checks. Windows canonicalization opens the pipe and consumes its single client connection before the SDK connects. Verify real native compiler connections on every consumer CI platform.

- [#75](https://github.com/ueberBrot/typepeek/pull/75) [`70c2eb3`](https://github.com/ueberBrot/typepeek/commit/70c2eb3af0fda59b3da972c0c31748eb337ad660) - Encapsulate static workspace configuration, bounded directory discovery, and consuming-workspace filtering while keeping CLI selection decisions together.

## 0.4.2

### Patch Changes

- [#73](https://github.com/ueberBrot/typepeek/pull/73) [`88067ec`](https://github.com/ueberBrot/typepeek/commit/88067ec1ff672bb085683520531fcdbba968d7d9) - Fix unnecessary cache misses caused by unrelated workspace dependencies.

## 0.4.1

### Patch Changes

- [#71](https://github.com/ueberBrot/typepeek/pull/71) [`bb7d6e8`](https://github.com/ueberBrot/typepeek/commit/bb7d6e8e3d0c3d2b198d3c7d0ef79d95d0aabba9) - Require Node.js 24.22.1 or later within the Node.js 24 release line to include the October 2026 security fixes.

## 0.4.0

### Minor Changes

- [#69](https://github.com/ueberBrot/typepeek/pull/69) [`f8340e4`](https://github.com/ueberBrot/typepeek/commit/f8340e4da12daad544b259981ba0c3b67952c39c) - Update the runtime dependencies to Effect 4.0.0-rc.112 and Execa 10.0.1.

### Patch Changes

- [#69](https://github.com/ueberBrot/typepeek/pull/69) [`f8340e4`](https://github.com/ueberBrot/typepeek/commit/f8340e4da12daad544b259981ba0c3b67952c39c) - Validate advertised Inspection Protocol request examples as JSON objects.

## 0.3.0

### Minor Changes

- [#61](https://github.com/ueberBrot/typepeek/pull/61) [`cac8278`](https://github.com/ueberBrot/typepeek/commit/cac82788ac1a6c7c9c5109c08951648dcff43b48) - Discover immediate public Members with `typepeek members <specifier> <export> [path]`. Results include each name's declaration spaces and the complete count before filtering. Use `--match` for case-insensitive name filtering. Member Discovery is also available through the Inspection Protocol and Inspection Plans.

  Disambiguate Member Paths with qualified segments such as `{ "name": "issues", "space": "type" }`. Each segment can select the parent's `type`, `value`, or `namespace` space. Existing string paths remain supported.

  Member Discovery resolves namespace re-exports and includes inherited standard-library names. It returns an explicit failure when a complete index exceeds its budget or contains members without supported static evidence.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Add `discover` to find exports by attached documentation and retrieve their signatures in one call.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Browse large export indexes with `overview --cursor start` and returned continuation cursors, including in Inspection Plans.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - `protocol` now accepts multiple requests in one CLI process, with one compact JSON request per line. The final newline is optional. Empty input exits successfully without a response.

### Patch Changes

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Enforce inspection limits when reading package manifests.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Support focused inspections and export searches in large packages such as the AWS S3 and EC2 SDKs.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Invalidate cached results when package manifests, installation markers, symlink targets, or declaration module formats change.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Fix standard-library inference with Node declarations and honor import/require conditions in type references. Prevent unrelated Node declarations from failing Inspection Plans.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Preserve required arguments in generic rest parameters and resolve substituted generic constraints.

- [#63](https://github.com/ueberBrot/typepeek/pull/63) [`027fc3a`](https://github.com/ueberBrot/typepeek/commit/027fc3ab03ca12c05d8fe62d31b6544ccf7fc193) - Preserve arrays, rest arguments, generic defaults, and installed Node global types in Signature Inspections and Export Inspections. These inspections now include the declarations needed to resolve types such as `string[]`, `TemplateExpression[]`, and `string | URL`, instead of returning `{}` or `any`. Inferred array and Promise types also retain their resolved form. Existing cache entries are invalidated so corrected results take effect immediately.

  Recognize standard-library declaration paths across Windows slash styles and drive casing.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Preserve type-only access through re-exports and aliases, and keep discovered member spaces consistent with exact member lookup.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Recognize Windows short paths when identifying TypeScript standard-library declarations.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Fix workspace discovery for extended glob patterns and pnpm lists with unindented entries or header comments.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Reduce startup time and speed up inspections and cache validation.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Reject inconsistent export and member results, including duplicate names, invalid counts, unrelated search matches, and missing member declarations.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Resolve declaration imports of a package's own public subpaths without requiring a dependency on itself.

- [#64](https://github.com/ueberBrot/typepeek/pull/64) [`886fce2`](https://github.com/ueberBrot/typepeek/commit/886fce2d0058254193dfe0fb674339321e49ce82) - Include Supporting Types referenced by inferred generic defaults, constraints, receivers, and index signatures.

## 0.2.1

### Patch Changes

- [#58](https://github.com/ueberBrot/typepeek/pull/58) [`1173e9b`](https://github.com/ueberBrot/typepeek/commit/1173e9b1b26af75114e7c3148dde500200851e6c) - Member Inspection now strips method and accessor bodies, property initializers, and nonconstant enum initializer expressions from package-exposed TypeScript source. It preserves public signatures and inferred types. Existing cached outcomes expire so they cannot return implementation code.

## 0.2.0

### Minor Changes

- [#55](https://github.com/ueberBrot/typepeek/pull/55) [`911230e`](https://github.com/ueberBrot/typepeek/commit/911230e9274761424955eae3814ed0ac11a1fc1d) - Inspect installed Package Modules that Node resolution exposes through an ancestor `node_modules` directory, including hoisted transitive dependencies that the consuming manifest does not declare.

  From a monorepo root, Typepeek now selects the only workspace that declares the requested package as a dependency. Use `--workspace <path>` to resolve ambiguity or select another consumer. This option replaces `--context`; comparison commands use `--before-workspace` and `--after-workspace`.

## 0.1.0

### Minor Changes

- [#48](https://github.com/ueberBrot/typepeek/pull/48) [`d909f37`](https://github.com/ueberBrot/typepeek/commit/d909f37a0d9f9547b6f10c09696a9baf6e631857) - Publish the initial Typepeek CLI and TypeScript inspection API.
