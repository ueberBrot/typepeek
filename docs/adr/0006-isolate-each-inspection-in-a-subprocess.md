# Isolate each inspection in a subprocess

Use one Execa-managed Node worker per normalized request. Accept one validated, byte-bounded JSON result after a clean exit.

The worker owns its TSRS process. Deadline and cancellation cleanup target the entire process tree; Fiber interruption waits for worker exit. The heap ceiling covers JavaScript memory. Native memory is constrained by input bounds and process lifetime, without a total-RSS guarantee.

Keep one production launcher; tests vary its entrypoint and limits. Direct Execa preserves lifecycle control without an Effect service.

Evidence resolution follows the synchronous SDK contract. Missing evidence, exhausted budgets, and process failures become deterministic Inspection Outcomes.
