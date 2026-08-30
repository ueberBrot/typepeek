# Typepeek

<p align="center">
  <img src="./assets/typepeek-logo.svg" alt="Typepeek logo" width="160">
</p>

Typepeek shows the TypeScript interface of an installed package without importing or executing it. Use it to find exports, inspect signatures and declarations, discover public subpaths, and compare the interfaces visible from two projects.

Typepeek reads the packages already installed for a project. Results match the package version, module conditions, and declarations available to that project. They do not rely on online documentation.

> [!WARNING]
> Typepeek is under active development and has not been released to npm. Run it from source for now; commands and interfaces may change before the first release.

## Why Typepeek

If your project imports `execa`, Typepeek can read the call signatures for its main export from the installed declarations:

```bash
node src/cli.ts signatures execa execa --context .
```

Typepeek returns each public call and construct signature in declaration order.

> [!IMPORTANT]
> Set `--context` to the consuming project's directory. Typepeek starts module resolution there, so the context determines which installed package and resolution conditions it sees.

## Try it from source

Typepeek requires Node.js 24.18 or later within the Node.js 24 release line and pnpm 11.20.

```bash
git clone https://github.com/ueberBrot/typepeek.git
cd typepeek
pnpm install --frozen-lockfile
node src/cli.ts overview execa --context .
```

`overview` is the default command, so the final command can also be written as:

```bash
node src/cli.ts execa --context .
```

Run `node src/cli.ts --help` for the complete command surface. The packaged artifact exposes the same commands through the `typepeek` executable.

## Choose an inspection

Start with the narrowest inspection that answers your question.

| Question                                                                                         | Command        |
| ------------------------------------------------------------------------------------------------ | -------------- |
| What does this module export?                                                                    | `overview`     |
| Which export names contain this text?                                                            | `search`       |
| Which public subpaths does this package expose?                                                  | `subpaths`     |
| How can I call or construct this export?                                                         | `signatures`   |
| What declarations define this export?                                                            | `declarations` |
| What defines this exact public member?                                                           | `member`       |
| Which declarations, signatures, supporting types, and package documentation explain this export? | `export`       |
| How can I run several inspections against one evidence snapshot?                                 | `plan`         |
| Which export names or public subpaths differ between two contexts?                               | `compare`      |

For example, discover an export before inspecting it:

```bash
node src/cli.ts search execa error --context .
node src/cli.ts declarations execa ExecaError --context .
```

Add `--json` for structured output. Add `--pretty` with `--json` when a person needs to read that output:

```bash
node src/cli.ts signatures execa execa --context . --json --pretty
```

Commands use the `import` access style by default. Pass `--access require` when you need the interface selected for CommonJS resolution conditions.

## What Typepeek inspects

Typepeek inspects installed package modules, their manifest-declared public subpaths, and linked workspace packages. It also inspects Node.js platform modules when the project can resolve `@types/node`. Typepeek supports ordinary `node_modules` installations produced by npm, pnpm, and Bun.

Inspection is static. Typepeek reads installed manifests, declarations, package-exposed TypeScript source, and attached JSDoc. It does not import package code, run package scripts, evaluate project configuration code, or download missing material.

Every inspection is bounded. Typepeek returns a complete result or an explicit typed failure when evidence is missing, unsupported, or too large. It does not present a partial result as authoritative.

## Use Typepeek with coding agents

Agents can use CLI JSON or the transport-neutral Inspection Protocol. `capabilities` describes the protocol version, supported intents, request fields, response options, failures, and budget dimensions without inspecting a package:

```bash
node src/cli.ts capabilities
```

Install the Typepeek agent skill with the [`skills.sh`](https://skills.sh) CLI:

```bash
npx skills@latest add ueberBrot/typepeek --skill typepeek
```

The skill teaches supported coding agents to choose the narrowest useful inspection. It does not install the Typepeek CLI.

Typepeek currently ships a CLI and a TypeScript inspection API. It does not ship an MCP server. An MCP adapter can use the same Inspection Protocol without invoking the CLI or parsing terminal output.

## TypeScript API

The `typepeek/inspection` package entry point exposes the transport-neutral inspection interface for programmatic integrations:

```ts
import {
  inspectCapabilities,
  inspectExportSignatures,
  inspectInterfaceOverview,
  invokeInspectionProtocol,
} from "typepeek/inspection";
```

Convenience functions return typed Inspection Outcomes. Adapter implementations can use `invokeInspectionProtocol` to keep protocol validation and recovery behavior consistent across transports.

## Development

Install the locked dependencies, then run the full validation suite:

```bash
vp install --frozen-lockfile
vp run validate
```

Useful development commands:

```bash
vp run check       # format, lint, and type-check
vp test            # run the test suite
vp build           # build the application bundle
vp pack            # build the publishable package
```
