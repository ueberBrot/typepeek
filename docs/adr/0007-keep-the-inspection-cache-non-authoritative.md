# Keep the inspection cache non-authoritative

The optional persistent cache stores successful Inspection Outcomes after the parent applies the same validation as for uncached results. Its identity includes the normalized request, package-manifest Typepeek version, compiler version, budget-policy identity, cache-semantics identity, and canonical Installed Evidence selection. Transport protocol versions do not affect canonical Inspection Outcomes. A change to any cache identity dimension creates a miss.

Automatic persistent reuse is enabled only for packaged builds with an embedded package version. Direct source execution requires an explicit cache directory. Persistence is disabled on Windows because private ownership cannot yet be verified.

## Proof replay

Each entry carries an Installed Evidence Proof for every consumed manifest and declaration, selected module or type-reference resolution, and traversed Public Subpath directory. Before returning a candidate, lookup repeats those bounded resolutions, directory fingerprints, and content fingerprints. Missing wildcard roots are represented by the nearest readable package directory, so newly materialized topology also invalidates the proof. Changed, unreadable, oversized, or invalid proofs produce cache misses.

## Storage boundary

Cache receipts and entries are byte-limited. The parent writes only after complete outcome validation, publishes by atomic rename inside a private non-symlink directory, and authenticates entries with a per-directory integrity key protected by those directory permissions. Failed, budget-exhausted, malformed, partial, timed-out, or terminated analysis is never stored. Cache deletion, corruption, saturation, or write failure can reduce reuse but cannot change an Inspection Outcome.

Strict Effect Schemas validate cache identities, Installed Evidence Proofs, IPC messages, payloads, and envelopes. A bounded snapshot first rejects accessors, inherited behavior, custom prototypes, symbols, sparse arrays, cycles, and values exceeding the string, graph, or serialized-byte limits.

A cache read bounds file metadata and bytes, then parses and strictly decodes only the outer envelope. It authenticates the exact payload string in constant time before parsing the payload. The payload codec leaves the outcome unknown while validating identity and proof.

The outcome's serialized bytes are bounded before the canonical request/outcome Schema validates it. Identity, result correlation, and Installed Evidence replay follow in that order. Encode failure, decode failure, or any mismatch becomes a miss or write no-op.

Cache I/O is synchronous and best-effort. Its local adapter handles every storage failure as a miss or write no-op. Because callers cannot act on these failures and no resource spans an Effect scope, an Effect Context/Layer would add configuration without improving resource cleanup or error handling.
