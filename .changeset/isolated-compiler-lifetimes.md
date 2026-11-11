---
"typepeek": patch
---

Keep native compiler processes and filesystem authority within each inspection. Serialize overlapping compiler operations, wait for active work during cleanup, and close every retained resource even when another close fails.
