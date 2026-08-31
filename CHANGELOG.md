# typepeek

## 0.2.0

### Minor Changes

- [#55](https://github.com/ueberBrot/typepeek/pull/55) [`911230e`](https://github.com/ueberBrot/typepeek/commit/911230e9274761424955eae3814ed0ac11a1fc1d) - Inspect installed Package Modules that Node resolution exposes through an ancestor `node_modules` directory, including hoisted transitive dependencies that the consuming manifest does not declare.

  From a monorepo root, Typepeek now selects the only workspace that declares the requested package as a dependency. Use `--workspace <path>` to resolve ambiguity or select another consumer. This option replaces `--context`; comparison commands use `--before-workspace` and `--after-workspace`.

## 0.1.0

### Minor Changes

- [#48](https://github.com/ueberBrot/typepeek/pull/48) [`d909f37`](https://github.com/ueberBrot/typepeek/commit/d909f37a0d9f9547b6f10c09696a9baf6e631857) - Publish the initial Typepeek CLI and TypeScript inspection API.
