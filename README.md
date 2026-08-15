# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable
Modules. Coding agents are the primary consumers; terminal users are secondary.

## Usage

Start with an Interface Overview of a package-root or Public Subpath Specifier
from the dependency installation visible to a Resolution Context:

```bash
typepeek overview zod --context .
# The overview command is also the default:
typepeek zod --context .
```

The initial command prints a deterministic Interface Overview:

```text
Interface Overview
Specifier: zod
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

`--json` emits one complete, newline-terminated Inspection Outcome on stdout.
Successful inspections exit with status 0; typed inspection failures exit with
status 1 and are also emitted as JSON on stdout. Valid inspection invocations
leave stderr empty. The structured schema is pre-stable and may change before
Typepeek 1.0.

Options follow the command name. Put `--` before a Module Export name that
begins with a hyphen. The `export` and `signatures` commands replace the old
`--export` and `--signatures-only` options.

The current slice supports installed, compiled Package Modules with declaration
entrypoints at package roots and manifest-declared Public Subpaths. Inspection
reads Installed Evidence only: it does not import the package runtime, run
package scripts, or download missing material. Unsupported, not-found, and
limit-exceeded inspections fail explicitly rather than returning a partial
authoritative result.

## Development

```bash
vp install --frozen-lockfile
vp run validate              # check → Fallow → test → build smoke → package smoke
vp run dependencies          # find eligible dependency updates
vp run dependencies:update   # select and apply updates
```

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
  inspectExportSignatures,
  inspectInterfaceOverview,
} from "typepeek/inspection";
```

All three functions accept a `resolutionContext` and `specifier`;
`inspectExport` and `inspectExportSignatures` additionally accept an
`exportName`. The CLI is one adapter over this interface. An MCP adapter is not
implemented yet; it can live in this package later and call the same functions
without invoking the CLI.

pnpm rejects package versions published less than seven days ago.

Deterministic validation steps are cached locally. Fallow and Taze always run
fresh. The pre-commit hook formats and lints staged files through `vp staged`.

## Conventions

- Internal imports use the Node-native `#typepeek/*` alias.
- Imports are grouped as built-in/external, alias, then relative imports.
- Barrel files use explicit named re-exports; wildcard re-exports are not used.
- Callers outside a folder use its barrel interface; modules inside the folder
  import concrete implementation files to avoid barrel cycles.
