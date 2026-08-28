# Center interfaces on a transport-neutral Inspection Core

Typepeek places contextual resolution and inspection orchestration in a transport-neutral Inspection Core. It produces structured inspection results while adapters own human-readable and protocol-specific rendering. The CLI is a thin adapter, and later interfaces such as MCP reuse the same `typepeek/inspection` package entrypoint instead of invoking the CLI or parsing rendered output.

## Public boundary

The source import alias and published subpath resolve to one canonical API module. Adapter requests use the Inspection Protocol dispatcher. Inspection Capabilities declare the protocol version, supported intents, Failure Reasons, and Budget Dimensions without probing Installed Evidence. Convenience functions remain available for typed in-process callers, while new adapters use the same dispatcher so protocol changes are explicit rather than inferred from a transport.

## Core implementation

One lazy Effect validates and dispatches every Inspection Core intent. Request definitions own one Effect Schema map for runtime normalization and the schema `Encoded` and `Type` views exported to TypeScript callers. Inspection Plan Query, analysis-envelope, Package Identity, cache, proof, and outcome types are also inferred directly from their authoritative schemas.

An accepted invocation retains its normalized request beside the authoritative, unprojected outcome, so protocol recovery never reconstructs trusted input. Typed convenience functions and the protocol dispatcher are the only Promise execution seams. Analysis and Public Interface Comparison remain composable Effects beneath them.
