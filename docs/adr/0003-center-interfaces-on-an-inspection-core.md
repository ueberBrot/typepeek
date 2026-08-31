# Center interfaces on a transport-neutral Inspection Core

Typepeek places contextual resolution and inspection orchestration in a transport-neutral Inspection Core. The core produces structured inspection results, while CLI adapters own human-readable and protocol rendering. The npm package exposes only the CLI. Programmatic adapters invoke its Inspection Protocol over stdin and stdout.

## Public boundary

The CLI binary is the package interface. Its `protocol` command is the machine-facing seam, and `capabilities` declares the protocol version, supported intents, Failure Reasons, and Budget Dimensions without probing Installed Evidence. Typepeek exports no JavaScript package subpath.

Inside the repository, `#typepeek/inspection` resolves to `src/inspection/index.ts`. This internal facade keeps CLI adapters and tests on one canonical interface without committing npm consumers to the implementation.

## Core implementation

One lazy Effect validates and dispatches every Inspection Core intent. Request definitions own one Effect Schema map for runtime normalization and its schema `Encoded` and `Type` views. Inspection Plan Query, analysis-envelope, Package Identity, cache, proof, and outcome types are inferred directly from their authoritative schemas.

An accepted invocation retains its normalized request beside the authoritative, unprojected outcome, so protocol recovery never reconstructs trusted input. Internal convenience functions and the protocol dispatcher are the only Promise execution seams. Analysis and Public Interface Comparison remain composable Effects beneath them.
