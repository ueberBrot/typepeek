---
"typepeek": minor
---

Inspect installed Package Modules that Node resolution exposes through an ancestor `node_modules` directory, including hoisted transitive dependencies that the consuming manifest does not declare.

From a monorepo root, Typepeek now selects the only workspace that declares the requested package as a dependency. Use `--workspace <path>` to resolve ambiguity or select another consumer. This option replaces `--context`; comparison commands use `--before-workspace` and `--after-workspace`.
