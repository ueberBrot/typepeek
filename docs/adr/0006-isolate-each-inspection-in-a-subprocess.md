# Isolate each inspection in a subprocess

## Process boundary

Inspection Core starts one execa-managed Node subprocess for each normalized request. It accepts one JSON result over byte-limited stdout only after the subprocess exits with code zero. The parent enforces a 10-second deadline, 100-millisecond kill escalation, 192 MiB old-generation heap, and 4 MiB stack.

Caller Fiber interruption aborts the execa-managed subprocess and waits for its exit under the same kill escalation before interruption completes. Process-launch and asynchronous transport failures use a private typed Effect error. Like a non-zero process exit, they become the deterministic `analysis-terminated` outcome and never escape Inspection Core as defects.

A process, rather than a worker thread, provides independent termination and startup-time memory enforcement.

## Adapter boundary

The subprocess boundary remains a direct Execa adapter rather than a Context/Layer service. Typepeek has one production launcher, and bounded entrypoint and limit inputs already provide its fixture variation. Lifecycle tests intentionally exercise the operating-system process seam.

A service environment would add provision requirements to the canonical Inspection Core Effect without adding another runtime implementation or stronger cleanup. Reconsider this choice if another launcher implementation becomes a real application dependency.

Installed Evidence resolution and compiler-host filesystem work remain synchronous. TypeScript requires synchronous host callbacks, and these bounded operations return domain absence or limit outcomes rather than recoverable storage errors.

The CLI protocol stream remains a Promise-based adapter edge owned by Stricli and Node streams; the transport-neutral Inspection Core is already an Effect beneath that edge. Wrapping either boundary in Effect services would move types without improving cleanup, substitution, or error authority.
