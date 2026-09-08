# typepeek

## 0.3.0

### Minor Changes

- [#61](https://github.com/ueberBrot/typepeek/pull/61) [`cac8278`](https://github.com/ueberBrot/typepeek/commit/cac82788ac1a6c7c9c5109c08951648dcff43b48) - Discover immediate public Members with `typepeek members <specifier> <export> [path]`. Results include each name's declaration spaces and the complete count before filtering. Use `--match` for case-insensitive name filtering. Member Discovery is also available through the Inspection Protocol and Inspection Plans.
  
  Disambiguate Member Paths with qualified segments such as `{ "name": "issues", "space": "type" }`. Each segment can select the parent's `type`, `value`, or `namespace` space. Existing string paths remain supported.
  
  Member Discovery resolves namespace re-exports and includes inherited standard-library names. It returns an explicit failure when a complete index exceeds its budget or contains members without supported static evidence.

### Patch Changes

- [#63](https://github.com/ueberBrot/typepeek/pull/63) [`027fc3a`](https://github.com/ueberBrot/typepeek/commit/027fc3ab03ca12c05d8fe62d31b6544ccf7fc193) - Preserve arrays, rest arguments, generic defaults, and installed Node global types in Signature Inspections and Export Inspections. These inspections now include the declarations needed to resolve types such as `string[]`, `TemplateExpression[]`, and `string | URL`, instead of returning `{}` or `any`. Inferred array and Promise types also retain their resolved form. Existing cache entries are invalidated so corrected results take effect immediately.
  
  Recognize standard-library declaration paths across Windows slash styles and drive casing.

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
