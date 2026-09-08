---
"typepeek": minor
---

Discover immediate public Members with `typepeek members <specifier> <export> [path]`. Results include each name's declaration spaces and the complete count before filtering. Use `--match` for case-insensitive name filtering. Member Discovery is also available through the Inspection Protocol and Inspection Plans.

Disambiguate Member Paths with qualified segments such as `{ "name": "issues", "space": "type" }`. Each segment can select the parent's `type`, `value`, or `namespace` space. Existing string paths remain supported.

Member Discovery resolves namespace re-exports and includes inherited standard-library names. It returns an explicit failure when a complete index exceeds its budget or contains members without supported static evidence.
