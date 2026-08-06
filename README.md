# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable
Modules. Coding agents are the primary consumers; terminal users are secondary.

## Usage

Inspect a package-root Specifier from the dependency installation visible to a
Resolution Context:

```bash
typepeek execa --context .
```

The initial command prints a deterministic Interface Overview:

```text
Interface Overview
Specifier: execa
Package: execa@10.0.0
Module Exports (30):
- $
- ExecaError
...
```

Select one Module Export for a focused Export Inspection:

```bash
typepeek execa --context . --export execa
```

The focused result keeps callable and constructable signatures in declaration
order, represents type, value, and namespace declaration spaces independently,
and follows only the bounded Supporting Types reachable from the selected
Module Export. Attached Package Documentation is labeled as untrusted Installed
Evidence and sanitized before terminal presentation.

The current slice supports installed, compiled Package Modules with declaration
entrypoints. Inspection reads Installed Evidence only: it does not import the
package runtime, run package scripts, or download missing material. Unsupported,
not-found, and limit-exceeded inspections fail explicitly rather than returning
a partial authoritative result.

## Setup

Install Vite+, which provisions the pinned Node.js and pnpm versions, then
install the locked dependencies:

```bash
curl -fsSL https://vite.plus | bash
vp install --frozen-lockfile
```

pnpm rejects package versions published less than seven days ago.

## Development

```bash
vp run validate              # check → Fallow → test → pack → package smoke
vp run dependencies          # find eligible dependency updates
vp run dependencies:update   # select and apply updates
```

Deterministic validation steps are cached locally. Fallow and Taze always run
fresh. The pre-commit hook formats and lints staged files through `vp staged`.

## Conventions

- Internal imports use the Node-native `#typepeek/*` alias.
- Imports are grouped as built-in/external, alias, then relative imports.
- Barrel files use explicit named re-exports; wildcard re-exports are not used.
- Callers outside a folder use its barrel interface; modules inside the folder
  import concrete implementation files to avoid barrel cycles.
