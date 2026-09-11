# Inspection Protocol

Run `typepeek capabilities --json` and construct requests from the installed version's descriptors. Execute bounded recovery requests as provided. Consult `typepeek protocol --help` for current wire limits.

## Stream requests

Start `typepeek protocol` with piped stdin and stdout. Send one compact JSON request per line, terminating each request with a newline so it can be processed while stdin remains open. Read one complete JSON response line per request, in submission order; each response becomes available when its inspection finishes. Each inspection returns a complete outcome.

For dependent queries, read the discovery response before sending the focused request. Close stdin after the final request and drain stdout before checking the process exit status.

Each request validates current Installed Evidence and can observe changes since the preceding request. Use an Inspection Plan when several known queries must share one Specifier and evidence snapshot.

## Read outcomes and continue

- Inspect each response's `outcome.status`. An inspection failure permits further requests but leaves the final process exit status nonzero, even if later requests succeed.
- A wire error has top-level `wireVersion`, `status`, and `reason` fields and ends the stream. Correct the input and start a new process before resuming.
- For export pagination, read `outcome.result.exportPage` and put its `nextCursor` in the next overview request's `request.cursor`. Apply the count, completion, and restart rules in [Browse large export indexes](SKILL.md#browse-large-export-indexes).

Finish when every submitted request has a response and the process has exited, or a wire/process failure accounts for the unanswered requests.
