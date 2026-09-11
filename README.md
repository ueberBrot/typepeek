# Typepeek

<p align="center">
  <img src="./assets/typepeek-logo.svg" alt="Typepeek logo" width="160">
</p>

Typepeek shows the TypeScript interface of an installed package without importing or executing it. Find exports, inspect signatures and declarations, and discover public subpaths from the version installed in your project.

Requires Node.js 24.18 or later within the Node.js 24 release line and a `node_modules` installation. Typepeek does not download missing packages; unsupported or oversized inspections return a typed failure.

## Quick start

Install Typepeek in a project that already contains the dependency you want to inspect. These examples use `execa`:

```bash
npm install --save-dev typepeek
npx typepeek overview execa
npx typepeek search execa error
npx typepeek signatures execa execa --json
```

Use `--json` for structured output and `--workspace packages/api` to select a workspace. Run `npx typepeek --help` for all commands, or see the [usage guide](docs/usage.md).

## Use with coding agents

Install the agent skill after installing the CLI:

```bash
npx skills@latest add ueberBrot/typepeek --skill typepeek
```

The skill guides agents in choosing an inspection and retrieving installed evidence.

## Benchmark

This controlled test compares agents searching and reading dependency files without Typepeek against agents given the Typepeek CLI and its shipped skill. Five fixed dependency-discovery tasks do not establish a real-world productivity benefit.

| Model / effort       | Without CLI: median time | With CLI + skill: median time | Without CLI: verified | With CLI + skill: verified |
| -------------------- | ------------------------ | ----------------------------- | --------------------- | -------------------------- |
| GPT-5.6 Terra / low  | 7.6 s                    | 12.9 s                        | 14/15                 | 15/15                      |
| GPT-5.6 Terra / high | 8.3 s                    | 12.8 s                        | 15/15                 | 15/15                      |
| GPT-5.6 Luna / low   | 9.8 s                    | 14.3 s                        | 15/15                 | 13/15                      |
| GPT-5.6 Luna / high  | 15.9 s                   | 21.6 s                        | 15/15                 | 15/15                      |
| GPT-5.6 Sol / low    | 7.7 s                    | 13.7 s                        | 13/15                 | 15/15                      |
| GPT-5.6 Sol / high   | 8.5 s                    | 15.8 s                        | 15/15                 | 15/15                      |
| GPT-6 Astra / low    | 9.2 s                    | 11.6 s                        | 15/15                 | 15/15                      |
| GPT-6 Astra / high   | 13.4 s                   | 11.7 s                        | 15/15                 | 14/15                      |

Times measure retrieval of sufficient evidence for verified matched pairs. These results show no general speedup from CLI plus skill. [Method, limitations, and reproduction](benchmarks/README.md).

## Documentation

- [Usage guide](docs/usage.md): commands, workspaces, pagination, members, and protocol access.
- [Contributing](CONTRIBUTING.md): local setup and checks.
