# Center interfaces on a transport-neutral Inspection Core

Typepeek places contextual resolution and inspection orchestration in a transport-neutral Inspection Core. It produces structured inspection results while adapters own human-readable and protocol-specific rendering. The CLI is a thin adapter, and later interfaces such as MCP reuse the same `typepeek/inspection` package entrypoint instead of invoking the CLI or parsing rendered output.

The source import alias and published subpath resolve to one canonical API module. Request and result shapes remain pre-stable until a second adapter demonstrates which parts of the contract should become stable, but they are already packaged so another adapter can share the bounded core without creating a competing interface.
