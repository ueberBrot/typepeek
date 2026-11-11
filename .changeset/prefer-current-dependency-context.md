---
"typepeek": patch
---

Skip workspace discovery when the current package declares the inspected dependency, avoiding unnecessary filesystem reads and failures caused by unrelated ancestor configuration.
