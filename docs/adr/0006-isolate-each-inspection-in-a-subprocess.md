# Isolate each inspection in a subprocess

## Process boundary

Inspection Core starts one execa-managed Node subprocess for each normalized request. It accepts one JSON result over byte-limited stdout only after the subprocess exits with code zero. The parent enforces a 10-second deadline, 100-millisecond kill escalation, 384 MiB old-generation heap, and 4 MiB stack. The heap allowance supports the pinned large-SDK corpus; it does not cap total process RSS.

Interrupting the caller Fiber aborts the subprocess and waits for its exit, using the same kill escalation. Launch failures, asynchronous transport failures, and nonzero exits return `analysis-terminated`. Inspection Core handles the private Effect errors internally.

A process, rather than a worker thread, provides independent termination and startup-time memory enforcement.

## Adapter boundary

Typepeek calls Execa directly. There is one production launcher; tests vary the entrypoint and limits while exercising real process lifecycles. An Effect Context/Layer would add configuration without another launcher or stronger cleanup.

Installed Evidence resolution and compiler-host filesystem work are synchronous because TypeScript requires synchronous host callbacks. These operations return missing-evidence or limit outcomes on failure.

The CLI protocol stream uses Promises, Stricli, and Node streams to invoke Inspection Core Effects.
