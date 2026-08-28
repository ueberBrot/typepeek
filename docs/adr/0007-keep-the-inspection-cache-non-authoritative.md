# Keep the inspection cache non-authoritative

The optional persistent cache stores only a successful Inspection Outcome after the parent process validates it at the same protocol seam as an uncached result. Its identity includes the normalized request, package-manifest Typepeek version, compiler version, named budget-policy version, cache semantics, and canonical Installed Evidence selection. Transport protocol versions do not affect canonical Inspection Outcomes. A change to any cache identity dimension creates a miss.

Automatic persistent reuse is enabled only for packaged builds with an embedded package version. Direct source execution requires an explicit cache directory. Windows persistence remains disabled until Typepeek can verify private ownership instead of assuming it.

## Proof replay

Each entry carries an Installed Evidence Proof for every consumed manifest and declaration, selected module or type-reference resolution, and traversed Public Subpath directory. Before returning a candidate, lookup repeats those bounded resolutions, directory fingerprints, and content fingerprints. Missing wildcard roots are represented by the nearest readable package directory, so newly materialized topology also invalidates the proof. A proof that changes, exceeds validation limits, cannot be read, or fails integrity validation produces a miss rather than authority.

## Storage boundary

Cache receipts and entries are byte-limited. The parent writes only after complete outcome validation, publishes by atomic rename inside a private non-symlink directory, and authenticates entries with a per-directory integrity key protected by those directory permissions. Failed, bounded, malformed, partial, timed-out, and terminated analysis is never stored. Cache deletion, corruption, saturation, or write failure can reduce reuse but cannot change an Inspection Outcome.

Strict Effect Schema codecs are the structural authority for cache identities, Installed Evidence Proofs, IPC messages, payloads, and envelopes. Before an IPC value reaches Schema, a bounded own-data snapshot rejects accessors, inherited behavior, custom prototypes, symbols, sparse arrays, cycles, oversized strings, excessive graph work, and excessive exact serialized bytes.

A cache read bounds file metadata and bytes, then parses and strictly decodes only the outer envelope. It authenticates the exact payload string in constant time before parsing the payload. The payload codec leaves the outcome unknown while validating identity and proof.

The outcome's serialized bytes are bounded before the canonical request/outcome Schema validates it. Identity, result correlation, and Installed Evidence replay follow in that order. Encode failure, decode failure, or any mismatch becomes a miss or write no-op.

Cache filesystem work remains synchronous and best-effort. It has one local adapter, no resource lifetime spanning an Effect scope, and no caller that can act on a typed storage failure. Every I/O failure deliberately collapses inside the cache boundary.

Introducing Effect services or Context/Layer here would expose optional storage mechanics without adding substitution, lifecycle safety, or domain authority. Reconsider this decision only if another storage adapter, a managed resource lifetime, or an error-consuming caller appears.
