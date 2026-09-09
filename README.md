# Typepeek

<p align="center">
  <img src="./assets/typepeek-logo.svg" alt="Typepeek logo" width="160">
</p>

Typepeek shows the TypeScript interface of an installed package without importing or executing it. Use it to find exports, inspect signatures and declarations, discover public subpaths, and compare the interfaces visible from two projects.

Results come from the package version, module conditions, and declarations installed for the consuming project.

Typepeek requires Node.js 24.18 or later within the Node.js 24 release line. The examples use npm because it ships with Node.js. If you prefer another package manager, use its equivalent install and run commands.

## Run Typepeek

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

Every project uses the same globally installed Typepeek version.

## Select a project and package

Read the main `execa` export's signatures from the installed declarations:

```bash
npx typepeek signatures execa execa
```

Results include every public call and construct signature in declaration order.

Typepeek first identifies the consumer from the current directory. From a monorepo root, it selects the only declared workspace that depends on the requested package. If several workspaces depend on it, select the consumer explicitly:

```bash
npx typepeek execa --workspace packages/api
```

Within a workspace, Typepeek stays scoped to that workspace. The `--workspace` option selects another consumer; pass its workspace directory, not a path into `node_modules`.

Inspect an installed package from the current project or workspace:

```bash
npx typepeek overview execa
```

`overview` is the default command. The shorthand is:

```bash
npx typepeek execa
```

Run `npx typepeek --help` for all commands and options. With a global installation, use `typepeek` directly.

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

## Browse large packages

Request an export page when an overview is too large:

```bash
npx typepeek overview @aws-sdk/client-ec2 --cursor start --json
```

Each page returns up to 100 names. Pass `result.exportPage.nextCursor` as `--cursor` to continue with the same package, workspace, and access style. Stop when `nextCursor` is absent. `totalModuleExports` is the full index count; `complete` is true only when one page contains the entire index. If the index changes, restart with `--cursor start`.

Use a discovered name for a focused query, or combine known queries in a plan:

```bash
npx typepeek signatures @aws-sdk/client-ec2 EC2Client --json
npx typepeek plan @aws-sdk/client-ec2 '[{"intent":"interface-overview","cursor":"start"},{"intent":"signature-inspection","exportName":"EC2Client"}]' --json
```

Pages share the normal output limits. Inspect a selected export for its declarations. An overview without a cursor returns the complete bounded index or a typed failure. Comparisons require complete indexes.

## Discover and inspect members

Use `members` when you know the export but need to find a public member. It lists immediate member names and their available declaration spaces without rendering the export's declarations or expanding supporting types:

```bash
npx typepeek members zod ZodError
npx typepeek members zod ZodError --match issue --json
```

`--match` filters names by a case-insensitive substring in both terminal and JSON output. Results include the complete count before filtering. An unmatched search returns an empty list. Typepeek still checks every candidate, even when a filter returns only a few names. If discovery exceeds a budget or cannot represent a public member, the entire inspection returns a typed failure.

Pass a member name to inspect its declarations, or a JSON array for a nested path:

```bash
npx typepeek member zod ZodError issues
```

A class can expose the same name through its instance type and its static value. Discovery labels those spaces as `type` and `value`; namespace exports use `namespace`. If an unqualified name selects distinct members, Typepeek returns `ambiguous-member`. Qualify that path segment with a space returned by discovery. For example, select `ZodError`'s instance member explicitly:

```bash
npx typepeek member zod ZodError '[{"name":"issues","space":"type"}]'
```

Each segment can be a name or a `{ "name": "…", "space": "type" | "value" | "namespace" }` selector. Qualified segments work at any depth and in Inspection Plans. Omit the path from `members` to list the export's immediate members; supply a path to list the selected member's children.

Discovery includes inherited members, including names from TypeScript's standard library. Inspecting one with `member` can return `unsupported-evidence` if its declaration cannot be traced to the project's installed files.

## What Typepeek inspects

Typepeek inspects installed package modules, their manifest-declared public subpaths, and linked workspace packages. It also inspects Node.js platform modules when the project can resolve `@types/node`. Typepeek supports ordinary `node_modules` installations produced by npm, pnpm, and Bun.

The requested package can be a hoisted transitive dependency absent from the consumer's manifest. It must resolve through an ancestor `node_modules` directory from the selected project or workspace. Typepeek does not search unrelated nested installations.

Inspection is static. Typepeek reads installed manifests, declarations, package-exposed TypeScript source, and attached JSDoc. It does not import package code, run package scripts, evaluate project configuration code, or download missing material.

Typepeek returns a complete result for the requested scope or a typed failure when evidence is missing, unsupported, or exceeds a budget. Export pages identify their scope and continuation; exceeding an analysis budget fails the page.

## Use Typepeek with coding agents

Agents can use CLI JSON or the transport-neutral Inspection Protocol. `capabilities` describes the protocol version, supported intents, request fields, response options, failures, and budget dimensions without inspecting a package:

```bash
npx typepeek capabilities
```

Install the Typepeek agent skill with the [`skills.sh`](https://skills.sh) CLI:

```bash
npx skills@latest add ueberBrot/typepeek --skill typepeek
```

The skill guides coding agents in choosing an inspection. Install the Typepeek CLI separately.

Programmatic integrations use the CLI's `protocol` command over stdin and stdout. Typepeek exposes no JavaScript library or MCP server.

Use `typepeek protocol` to send successive compact JSON request lines through one CLI process. It returns one response line per request, in order, while each inspection retains its isolated analysis process. See `typepeek protocol --help` for input limits and failure handling.

## Development

Install [Vite+ CLI 0.3.0](https://viteplus.dev/guide/) or newer for development; pnpm 12 requires its native-binary support. It manages Node.js 24.18 and downloads the pnpm 12.3.4 version pinned in `package.json`. Install the locked dependencies and run the full validation suite:

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
