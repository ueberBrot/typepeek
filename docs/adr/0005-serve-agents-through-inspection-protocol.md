# Serve agents through the Inspection Protocol

Inspection Core produces transport-neutral outcomes. Protocol responses may project signature evidence as `structured`, `exact`, or `both`; the default is `structured` to avoid duplicating compiler text. They may also attach bounded, deterministic recovery requests derived from a validated request. Projection and recovery preserve the validated outcome.

The CLI `protocol` command accepts byte-limited requests over stdin and returns responses over stdout. External integrations use this command; the inspection functions are internal to the package.

Cache semantics version the stored outcomes independently of the protocol. Deterministic protocol tests measure payload bytes and recovery requests. Agent quality requires separate evaluation.
