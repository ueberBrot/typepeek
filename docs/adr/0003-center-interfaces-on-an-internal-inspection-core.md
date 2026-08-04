# Center interfaces on an internal Inspection Core

Typepeek places contextual resolution and inspection orchestration in a transport-neutral internal Inspection Core. It produces structured inspection results while adapters own human-readable and protocol-specific rendering. The CLI is its first thin adapter, and later interfaces such as MCP may reuse it; the core API and result shape remain internal and unstable until implementation and a second interface demonstrate which boundary is worth publishing.
