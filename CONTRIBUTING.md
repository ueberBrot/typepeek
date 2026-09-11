# Contributing

## Set up

Install [Vite+ CLI](https://viteplus.dev/guide/) 0.3.0 or newer, then install the project's locked dependencies:

```bash
vp install --frozen-lockfile
```

## Check your changes

Run the full validation suite before submitting a change:

```bash
vp run validate
```

For focused work:

```bash
vp run check       # format, lint, and type-check
vp test            # run tests
vp pack            # build the publishable package
```

For runtime or application changes, add a concise user-facing release note with `vp run changeset`. Documentation, tests, and benchmarks do not need a changeset.

Live model benchmarks are optional and require authenticated Codex access. See the [benchmark guide](benchmarks/README.md).
