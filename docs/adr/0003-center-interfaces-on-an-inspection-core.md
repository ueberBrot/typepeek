# Center interfaces on a transport-neutral Inspection Core

Inspection Core resolves modules and produces structured inspection results. CLI adapters render terminal and protocol output. The npm package exposes only the CLI; programmatic integrations use its Inspection Protocol over stdin and stdout.

## Public boundary

The CLI binary is the package interface. Its `protocol` command accepts machine requests. The `capabilities` command lists the protocol version, supported intents, Failure Reasons, and Budget Dimensions without reading Installed Evidence. Typepeek exports no JavaScript package subpath.

Inside the repository, `#typepeek/inspection` resolves to `src/inspection/index.ts`. CLI adapters and tests use this internal interface; it is not exported to npm consumers.

## Core implementation

A lazy Effect validates and dispatches each Inspection Core request. Effect Schemas define request normalization and the corresponding `Encoded` and `Type` types. Inspection Plan Query, analysis-envelope, Package Identity, cache, proof, and outcome types are also inferred from their schemas.

An accepted invocation retains its normalized request and unprojected outcome for protocol recovery. Internal convenience functions and the protocol dispatcher convert Effects to Promises; analysis and Public Interface Comparison compose as Effects.
