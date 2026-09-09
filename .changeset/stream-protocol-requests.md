---
"typepeek": minor
---

Make `protocol` process compact JSON request lines without restarting the CLI. Each request must fit on one line; a single request without a final newline still works. Empty input now exits successfully without a response.

Reduce inspection and cache-validation overhead for missing resolution paths.

Reject changed evidence before replaying resolutions, and share bounded resolution hosts within each replay.

Preserve standard-library inference when declaration inspection also needs Node declarations.

Preserve import and require conditions in type-reference declarations and cache proof replay.

Keep Node declaration validation focused on the exports selected by an Inspection Plan.
