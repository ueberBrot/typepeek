# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable
Modules. Coding agents are the primary consumers; terminal users are secondary.

## Usage

Inspect a package-root or Public Subpath Specifier from the dependency
installation visible to a Resolution Context:

```bash
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
typepeek zod --context . --subpaths
typepeek "@scope/package/public-subpath" --context .
```

Select one Module Export for a focused Export Inspection:

```bash
typepeek zod --context . --export z
```

The focused result keeps callable and constructable signatures in declaration
order, represents type, value, and namespace declaration spaces independently,
and follows only the bounded Supporting Types reachable from the selected
Module Export. Attached Package Documentation is labeled as untrusted Installed
Evidence and sanitized before terminal presentation.

When signatures and their parameters are the question, skip declaration and
Supporting Type traversal entirely:

```bash
typepeek zod --context . --export ZodError --signatures-only
```

For agents, `--json` emits one complete, newline-terminated Inspection Outcome
on stdout. Successful inspections exit with status 0; typed inspection failures
exit with status 1 and are also emitted as JSON on stdout. Valid inspection
invocations leave stderr empty. The structured schema is pre-stable and may
change before Typepeek 1.0.

```bash
typepeek zod --context . --export ZodError --signatures-only --json
```

The current slice supports installed, compiled Package Modules with declaration
entrypoints at package roots and manifest-declared Public Subpaths. Inspection
reads Installed Evidence only: it does not import the package runtime, run
package scripts, or download missing material. Unsupported, not-found, and
limit-exceeded inspections fail explicitly rather than returning a partial
authoritative result.

## Development

```bash
vp install --frozen-lockfile
vp run validate              # check → Fallow → test → pack → package smoke
vp run dependencies          # find eligible dependency updates
vp run dependencies:update   # select and apply updates
```

Run the source entry directly while developing:

```bash
node src/cli.ts zod --context /path/to/consumer
```

To test the publishable artifact, build `dist`, then invoke its CLI against a
consumer whose installed packages you want to inspect:

```bash
vp pack
node dist/cli.js zod --context /path/to/consumer --export ZodError --signatures-only
```

`vp build` produces the application bundle under `.vite-plus/build`; `vp pack`
produces the publishable `dist` artifact and declaration files used by package
smoke tests.

## Inspection API

CLI, MCP, and other adapters share the transport-neutral package API. It returns
typed Inspection Outcomes and never requires consumers to parse terminal or JSON
rendering:

```ts
import {
  inspectExport,
  inspectExportSignatures,
  inspectInterfaceOverview,
} from "typepeek/inspection";
```

All three functions accept a `resolutionContext` and `specifier`;
`inspectExport` and `inspectExportSignatures` additionally accept an
`exportName`. The CLI is one adapter over this API, not a prerequisite for using
the Inspection Core.

pnpm rejects package versions published less than seven days ago.

Deterministic validation steps are cached locally. Fallow and Taze always run
fresh. The pre-commit hook formats and lints staged files through `vp staged`.

## Conventions

- Internal imports use the Node-native `#typepeek/*` alias.
- Imports are grouped as built-in/external, alias, then relative imports.
- Barrel files use explicit named re-exports; wildcard re-exports are not used.
- Callers outside a folder use its barrel interface; modules inside the folder
  import concrete implementation files to avoid barrel cycles.
