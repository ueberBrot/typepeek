# Center interfaces on a transport-neutral Inspection Core

Typepeek places contextual resolution and inspection orchestration in a transport-neutral Inspection Core. It produces structured inspection results while adapters own human-readable and protocol-specific rendering. The CLI is a thin adapter, and later interfaces such as MCP reuse the same `typepeek/inspection` package entrypoint instead of invoking the CLI or parsing rendered output.

The source import alias and published subpath resolve to one canonical API module. Adapter requests use the Inspection Protocol dispatcher. Inspection Capabilities declare the protocol version, supported intents, Failure Reasons, and Budget Dimensions without probing Installed Evidence. Convenience functions remain available for typed in-process callers, while new adapters use the same dispatcher so protocol changes are explicit rather than inferred from a transport.
