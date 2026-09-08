# Typepeek

<p align="center">
  <img src="./assets/typepeek-logo.svg" alt="Typepeek logo" width="160">
</p>

Typepeek shows the TypeScript interface of an installed package without importing or executing it. Use it to find exports, inspect signatures and declarations, discover public subpaths, and compare the interfaces visible from two projects.

Typepeek reads the packages already installed for a project. Results match the package version, module conditions, and declarations available to that project. They do not rely on online documentation.

Typepeek requires Node.js 24.18 or later within the Node.js 24 release line. The examples use npm because it ships with Node.js. If you prefer another package manager, use its equivalent install and run commands.

## Run Typepeek

Choose how to run Typepeek.

### Install in a project

For repeatable use, install Typepeek as a development dependency:

```bash
npm install --save-dev typepeek
npx typepeek overview execa
```

`npx` uses the project-local executable when Typepeek is installed.

### Run once

Run the latest release without adding Typepeek to `package.json`:

```bash
npx --yes typepeek@latest overview execa
```

### Install globally

Install one version for direct use across projects:

```bash
npm install --global typepeek
typepeek overview execa
```

A global installation is convenient, but every project shares the installed version.

## Why Typepeek

If your project imports `execa`, Typepeek can read the call signatures for its main export from the installed declarations:

```bash
npx typepeek signatures execa execa
```

Typepeek returns each public call and construct signature in declaration order.

Typepeek first identifies the consumer from the current directory. From a monorepo root, it selects the only declared workspace that depends on the requested package. If several workspaces depend on it, select the consumer explicitly:

```bash
npx typepeek execa --workspace packages/api
```

Within a workspace, Typepeek stays scoped to that workspace. The `--workspace` option selects another consumer; pass its workspace directory, not a path into `node_modules`.

Inspect an installed package from the current project or workspace:

```bash
npx typepeek overview execa
```

`overview` is the default command, so the final command can also be written as:

```bash
npx typepeek execa
```

Run `npx typepeek --help` for the complete command surface. If you installed Typepeek globally, invoke `typepeek` directly instead.

## Choose an inspection

Start with the narrowest inspection that answers your question.

| Question                                                                                         | Command        |
| ------------------------------------------------------------------------------------------------ | -------------- |
| What does this module export?                                                                    | `overview`     |
| Which export names contain this text?                                                            | `search`       |
| Which public subpaths does this package expose?                                                  | `subpaths`     |
| How can I call or construct this export?                                                         | `signatures`   |
| What declarations define this export?                                                            | `declarations` |
| Which public members are available beneath this export?                                          | `members`      |
| What defines this exact public member?                                                           | `member`       |
| Which declarations, signatures, supporting types, and package documentation explain this export? | `export`       |
| How can I run several inspections against one evidence snapshot?                                 | `plan`         |
| Which export names or public subpaths differ between two workspaces?                             | `compare`      |

For example, discover an export before inspecting it:

```bash
npx typepeek search execa error
npx typepeek declarations execa ExecaError
```

Add `--json` for structured output. Add `--pretty` with `--json` when a person needs to read that output:

```bash
npx typepeek signatures execa execa --json --pretty
```

Commands use the `import` access style by default. Pass `--access require` when you need the interface selected for CommonJS resolution conditions.

## Discover and inspect members

Use `members` when you know the export but need to find a public member. It lists immediate member names and their available declaration spaces without rendering the export's declarations or expanding supporting types:

```bash
npx typepeek members zod ZodError
npx typepeek members zod ZodError --match issue --json
```

`--match` filters names by a case-insensitive substring in both terminal and JSON output. Results include the complete count before filtering. An unmatched search returns an empty list. If discovery exceeds a budget or cannot represent a public member, the entire inspection returns a typed failure.

Pass a member name to inspect its declarations, or a JSON array for a nested path:

```bash
npx typepeek member zod ZodError issues
```

A class can expose the same name through its instance type and its static value. Discovery labels those spaces as `type` and `value`; namespace exports use `namespace`. If an unqualified name selects distinct members, Typepeek returns `ambiguous-member`. Qualify that path segment with a space returned by discovery. For example, select `ZodError`'s instance member explicitly:

```bash
npx typepeek member zod ZodError '[{"name":"issues","space":"type"}]'
```

Each segment can be a name or a `{ "name": "…", "space": "type" | "value" | "namespace" }` selector. Qualified segments work at any depth and in Inspection Plans. Omit the path from `members` to list the export's immediate members; supply a path to list the selected member's children.

## What Typepeek inspects

Typepeek inspects installed package modules, their manifest-declared public subpaths, and linked workspace packages. It also inspects Node.js platform modules when the project can resolve `@types/node`. Typepeek supports ordinary `node_modules` installations produced by npm, pnpm, and Bun.

A requested Package Module need not appear in the Resolution Context's manifest. Typepeek can inspect it when its Specifier resolves through an ancestor `node_modules` directory, including when the installation hoists it for another Package Module. From a monorepo root, Typepeek selects a workspace when exactly one declares the package as a dependency. Typepeek does not scan nested `node_modules` directories that no selected Resolution Context can resolve.

Inspection is static. Typepeek reads installed manifests, declarations, package-exposed TypeScript source, and attached JSDoc. It does not import package code, run package scripts, evaluate project configuration code, or download missing material.

Every inspection is bounded. Typepeek returns a complete result or an explicit typed failure when evidence is missing, unsupported, or too large. It does not present a partial result as authoritative.

## Use Typepeek with coding agents

Agents can use CLI JSON or the transport-neutral Inspection Protocol. `capabilities` describes the protocol version, supported intents, request fields, response options, failures, and budget dimensions without inspecting a package:

```bash
npx typepeek capabilities
```

Install the Typepeek agent skill with the [`skills.sh`](https://skills.sh) CLI:

```bash
npx skills@latest add ueberBrot/typepeek --skill typepeek
```

The skill teaches supported coding agents to choose the narrowest useful inspection. It does not install the Typepeek CLI.

Typepeek ships a CLI. Programmatic adapters invoke the `protocol` command over stdin and stdout. Typepeek exposes no JavaScript library and ships no MCP server.

## Development

Install [Vite+](https://viteplus.dev/guide/) for development. It manages Node.js 24.18 and downloads the pnpm 12.3.4 version pinned in `package.json`. Install the locked dependencies and run the full validation suite:

```bash
vp install --frozen-lockfile
vp run validate
```

CI and release jobs use the same Vite+ setup and frozen install. The standard [`pnpm/setup`](https://github.com/pnpm/setup) action also makes pnpm available for direct commands and consumer tests, with dependency installation disabled. Both tools read the same `packageManager` pin. Local development needs only Vite+.

`pnpm-workspace.yaml` sets [`pmOnFail: ignore`](https://pnpm.io/settings/cli#pmonfail) because Vite+ owns package-manager version selection. This also keeps the dependency lockfile in one YAML document, avoiding the [reported GitHub dependency-graph parsing issue](https://github.com/pnpm/pnpm/issues/13805).

Useful development commands:

```bash
vp run check       # format, lint, and type-check
vp test            # run the test suite
vp build           # build the application bundle
vp pack            # build the publishable package
```
