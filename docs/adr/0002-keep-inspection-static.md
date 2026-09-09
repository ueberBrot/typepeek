# Keep inspection static

Typepeek inspects installed declarations and attached documentation without executing dependency or project configuration code. It uses its bundled analyzer and never loads the repository's compiler or compiler plugins.

Cases that require execution are unsupported, so agents can inspect unfamiliar repositories without running their code.
