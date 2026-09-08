---
"typepeek": patch
---

Preserve arrays, rest arguments, generic defaults, and installed Node global types in Signature Inspections and Export Inspections. These inspections now include the declarations needed to resolve types such as `string[]`, `TemplateExpression[]`, and `string | URL`, instead of returning `{}` or `any`. Inferred array and Promise types also retain their resolved form. Existing cache entries are invalidated so corrected results take effect immediately.
