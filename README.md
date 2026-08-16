# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable
Modules. Coding agents are the primary consumers; terminal users are secondary.

## Usage

Start with an Interface Overview of a Package Module root, Public Subpath, or
Node Platform Module visible from a Resolution Context:

```bash
typepeek overview zod --context .
# The overview command is also the default:
typepeek zod --context .
```

The initial command prints a deterministic Interface Overview:

```text
Interface Overview
Specifier: zod
Access Style: import
Package: zod@<installed-version>
Module Exports (...):
- ZodError
- ZodType
- z
...
Public Subpaths (...; use --subpaths to list):
```

At a package root, the Interface Overview also advertises manifest-declared
Public Subpath count without flooding the default output. Pass `--subpaths` to
list their exact Specifiers. Public Subpath Patterns are expanded from bounded
Installed Evidence and only concrete Specifiers in the selected Resolution
Variant are advertised:

```bash
typepeek overview zod --context . --subpaths
typepeek overview "@scope/package/public-subpath" --context .
```

For a large Interface Overview, match Module Export names with a deterministic,
case-insensitive substring. The heading reports both the match count and the
complete count so filtered output is never mistaken for a complete overview:

```bash
typepeek overview zod --match error
```

For discovery without a complete Interface Overview, search Module Export names
or read only manifest Public Subpaths:

```bash
typepeek search zod error --context .
typepeek subpaths zod --context .
```

Export Search scans at most 4,096 names and returns at most 320 deterministic
case-insensitive substring matches, so it can query an index broader than the
320-entry overview limit. Public Subpath Discovery resolves bounded manifest
evidence without materializing a TypeScript program.

Use Signature Inspection when you need the call or construct parameters for
one Module Export. It skips declarations and Supporting Types:

```bash
typepeek signatures zod ZodError --context .
```

Human output shows the exact compiler-rendered signatures. For agents, `--json`
adds structured type parameters, an explicit `this` parameter, ordinary
parameters, and return semantics. It also keeps the exact signature text:

```bash
typepeek signatures arktype type --context . --json
```

Use Export Inspection when you also need declarations, Package Documentation,
or bounded Supporting Types:

```bash
typepeek export zod ZodError --context .
typepeek export zod ZodError --context . --json
```

The focused result keeps compact callable and constructable signature text in
declaration order, represents type, value, and namespace declaration spaces
independently, and follows only the bounded Supporting Types reachable from the
selected Module Export. Attached Package Documentation is labeled as untrusted
Installed Evidence and sanitized before terminal presentation.

Use an Inspection Plan when several questions concern the same Specifier. The
ordered JSON query list runs atomically over one Declaration Provider selection
and one TypeScript program materialization:

```bash
typepeek plan zod '[{"intent":"interface-overview"},{"intent":"signature-inspection","exportName":"ZodError"}]' --context . --json
```

Plans accept 1 through 16 `interface-overview`, `export-inspection`,
`signature-inspection`, `export-search`, or `public-subpath-discovery` queries.
If any query fails, the whole plan returns that typed failure without partial
results.

`--json` emits one complete, newline-terminated Inspection Outcome on stdout,
including the selected Access Style. Successful inspections exit with status 0;
typed inspection failures exit with status 1 and are also emitted as JSON on
stdout. Invalid invocations exit with status 2 and emit an
`invalid-invocation` CLI diagnostic as JSON. Unexpected CLI failures use status 70. Machine-mode invocations leave stderr empty. The structured schemas are
pre-stable and may change before Typepeek 1.0.

The common `--access`, `--context`, and `--json` options may precede or follow an
explicit command. `--subpaths` and `--match` affect only human Interface
Overview rendering and cannot be combined with `--json`, whose complete result
already contains every Public Subpath and Module Export. Put `--` before a
Module Export name that begins with a hyphen. The `export` and `signatures`
commands replace the old `--export` and `--signatures-only` options. Invoking
`typepeek` without arguments prints root help.

Typepeek supports installed Package Modules backed by declarations or
package-exposed TypeScript source, manifest-declared Public Subpaths, separate
Declaration Providers, linked workspace packages, and Node Platform Modules
backed by a visible `@types/node`. Inspection reads Installed Evidence only: it
does not import the package runtime, run package scripts, or download missing
material. Unsupported, not-found, static-boundary, and limit-exceeded
inspections fail explicitly rather than returning a partial authoritative
result.

## Development

```bash
vp install --frozen-lockfile
vp run validate              # check → Fallow → test → build smoke → package smoke
vp run dependencies          # find eligible dependency updates
vp run dependencies:update   # select and apply updates
vp run benchmark:source      # measure source-checkout inspection latency
vp run benchmark:build       # measure the application bundle
vp run benchmark:package     # measure the publishable artifact
```

Set `TYPEPEEK_PROFILE=1` on a source-checkout invocation to emit bounded,
non-authoritative phase timings as JSON on stderr. Profiling never changes the
Inspection Outcome on stdout and is disabled by default. Build and package
artifacts exclude this repository-only diagnostic path.

Run the source entry directly while developing:

```bash
node src/cli.ts signatures zod ZodError --context /path/to/consumer
```

To test the application bundle, build it and invoke its CLI against a consumer
whose installed packages you want to inspect:

```bash
vp build
node .vite-plus/build/cli.js signatures zod ZodError --context /path/to/consumer --json
```

To test the publishable artifact, build `dist` and invoke that CLI:

```bash
vp pack
node dist/cli.js signatures zod ZodError --context /path/to/consumer --json
```

`vp build` produces the application bundle under `.vite-plus/build`; `vp pack`
produces the publishable `dist` artifact and declaration files used by package
smoke tests.

## Inspection API

The CLI and future adapters use the same transport-neutral package interface.
It returns typed Inspection Outcomes, so consumers do not need to parse CLI
output:

```ts
import {
  inspectExport,
  inspectExportSearch,
  inspectExportSignatures,
  inspectInterfaceOverview,
  inspectPlan,
  inspectPublicSubpaths,
} from "typepeek/inspection";
```

All six functions accept a `resolutionContext` and `specifier`;
`inspectExport` and `inspectExportSignatures` additionally accept an
`exportName`; `inspectExportSearch` accepts a bounded query;
`inspectPlan` accepts the bounded ordered query list. The CLI is one adapter
over this interface. An MCP adapter is not implemented yet; it can live in this
package later and call the same functions without invoking the CLI.

pnpm rejects package versions published less than seven days ago.

Deterministic validation steps are cached locally. Fallow and Taze always run
fresh. The pre-commit hook formats and lints staged files through `vp staged`.

## Conventions

- Internal imports use the Node-native `#typepeek/*` alias.
- Imports are grouped as built-in/external, alias, then relative imports.
- Barrel files use explicit named re-exports; wildcard re-exports are not used.
- Callers outside a folder use its barrel interface; modules inside the folder
  import concrete implementation files to avoid barrel cycles.
