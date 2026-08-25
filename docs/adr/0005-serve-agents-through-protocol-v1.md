# Serve agents through protocol version 1

Typepeek's first released Inspection Protocol is version 1. Unreleased version labels have no compatibility obligation.

Inspection Core owns canonical, transport-neutral outcomes. Protocol responses may project signature evidence as `structured`, `exact`, or `both`; the default is `structured` to avoid duplicating compiler text. They may also attach bounded, deterministic recovery requests derived from a validated request. Projection and recovery never weaken or replace the authoritative outcome.

The CLI `protocol` command is a thin, byte-bounded stdin/stdout adapter over the public protocol function. Future adapters, including MCP, must call the same package API rather than invoke or parse the CLI.

Cache semantics version canonical outcomes independently of transport versions. Deterministic workloads measure payload bytes and executable recovery behavior, not agent quality.
