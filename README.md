# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable
Modules. Coding agents are the primary consumers; terminal users are secondary.

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
