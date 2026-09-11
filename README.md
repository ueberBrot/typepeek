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

This controlled test measures dependency discovery, not end-to-end coding productivity; a real-world benefit is not established. Samples are small and uneven, so compare tools within each row, not models across rows.

Local run on 2026-09-11: five behavior-based questions, Apple M1 Max, Codex 0.154.0. The two-million-token cap stopped the run after **52 of 240 scheduled attempts**; CLI trials include the shipped Typepeek skill.

| Model / effort       | Evidence found: files · CLI | Median seconds: files · CLI | Successful pairs |
| -------------------- | --------------------------- | --------------------------- | ---------------- |
| GPT-5.6 Terra / low  | 6/6 · 6/6                   | 8.5 · 11.9                  | 6                |
| GPT-5.6 Terra / high | 3/3 · 3/3                   | 16.2 · 11.6                 | 3                |
| GPT-5.6 Luna / low   | 3/4 · 4/4                   | 29.9 · 18.7                 | 3                |
| GPT-5.6 Luna / high  | 1/1 · 1/1                   | 28.1 · 13.8                 | 1                |
| GPT-5.6 Sol / low    | 2/2 · 2/2                   | 9.7 · 13.3                  | 2                |
| GPT-5.6 Sol / high   | Not run                     | —                           | 0                |
| GPT-6 Astra / low    | 6/6 · 6/6                   | 8.9 · 17.1                  | 6                |
| GPT-6 Astra / high   | 4/4 · 4/4                   | 8.1 · 12.2                  | 4                |

Time runs from question submission to sufficient retrieved evidence, excluding final-answer writing. Medians use only successful matched pairs; success counts include all attempts. Neither approach was consistently faster. [Method and reproduction instructions](benchmarks/README.md).

## Documentation

- [Usage guide](docs/usage.md): commands, workspaces, pagination, members, and protocol access.
- [Contributing](CONTRIBUTING.md): local setup and checks.
