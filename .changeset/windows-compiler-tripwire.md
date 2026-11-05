---
"typepeek": patch
---

Correct the Windows consumer test guard's native compiler pipe allowance, including write permission for the SDK's named pipe. Cover accepted and rejected launches and pipe permissions with portable regression tests.

Keep compiler pipe paths literal during guard checks. Windows canonicalization opens the pipe and consumes its single client connection before the SDK connects. Verify real native compiler connections on every consumer CI platform.
