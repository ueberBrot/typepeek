---
"typepeek": minor
---

Make `protocol` process compact JSON request lines without restarting the CLI. Each request must fit on one line; a single request without a final newline still works. Empty input now exits successfully without a response.

Reduce inspection and cache-validation overhead for missing resolution paths.
