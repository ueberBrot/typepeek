# Keep inspection static

Typepeek inspects installed declarations and attached documentation without executing dependency or project configuration code. It uses its own known analysis implementation instead of loading the repository's TypeScript compiler or compiler plugins.

Cases that require execution are unsupported. This narrower compatibility gives coding agents a dependable no-execution boundary when they inspect unfamiliar repositories.
