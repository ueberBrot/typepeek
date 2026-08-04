# Keep inspection static

Typepeek inspects installed declarations and attached documentation without executing dependency or project configuration code. It uses its own known analysis implementation rather than loading the repository's TypeScript compiler or compiler plugins. Cases that require execution are unsupported, accepting narrower compatibility in exchange for a dependable no-execution boundary for coding agents inspecting unfamiliar repositories.
