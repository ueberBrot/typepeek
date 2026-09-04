---
"typepeek": patch
---

Member Inspection now strips method and accessor bodies, property initializers, and nonconstant enum initializer expressions from package-exposed TypeScript source. It preserves public signatures and inferred types. Existing cached outcomes expire so they cannot return implementation code.
