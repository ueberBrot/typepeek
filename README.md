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
npx typepeek discover execa split --json
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

| Task       | Files: time | CLI + skill: time | Files: tokens | CLI + skill: tokens |
| ---------- | ----------: | ----------------: | ------------: | ------------------: |
| TypeScript |      40.5 s |            12.2 s |         86.8k |               18.3k |
| Stricli    |       8.1 s |            18.1 s |         29.5k |               34.3k |
| Execa      |       8.5 s |            17.9 s |         26.6k |               33.2k |
| Effect     |      10.7 s |            13.3 s |         30.4k |               19.3k |
| Node       |       7.6 s |             9.6 s |         24.6k |               16.1k |

Medians cover 118 matched pairs with verified evidence. Times measure task submission to sufficient evidence; tokens cover the whole task, including final-answer generation.

Typepeek was faster on the TypeScript task and slower on the other four. Across all 240 attempts, it used 34.3% fewer tokens, although savings varied by task. [Method, limitations, and reproduction](benchmarks/README.md).

## Documentation

- [Usage guide](docs/usage.md): commands, workspaces, pagination, members, and protocol access.
- [Contributing](CONTRIBUTING.md): local setup and checks.
