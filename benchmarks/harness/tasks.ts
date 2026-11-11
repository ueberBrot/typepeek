export const shellArgument = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const harnessCommand = (
  task: string,
  cliArguments: readonly string[]
): string => {
  const tail = cliArguments.map(shellArgument).join(" ");

  switch (task) {
    case "test": {
      return `node_modules/.bin/vp test --maxWorkers=2 ${tail}`;
    }

    case "quality": {
      if (cliArguments.length > 0) {
        throw new Error("quality does not accept additional arguments.");
      }

      return "node_modules/.bin/vp run check";
    }

    case "benchmark-smoke": {
      return `node_modules/.bin/vp pack && node tests/benchmark-package-smoke.ts ${tail}`;
    }

    case "benchmark": {
      if (
        cliArguments.some(
          (argument) =>
            argument === "--output" || argument.startsWith("--output=")
        )
      ) {
        throw new Error(
          "Use the harness --output option to preserve benchmark artifacts."
        );
      }

      return `node_modules/.bin/vp pack && TYPEPEEK_DOCKER_CODEX=true node benchmarks/codex-discovery/run.ts --output .benchmarks/sandbox-results ${tail}`;
    }

    default: {
      throw new Error(`Unknown sandbox task: ${task}`);
    }
  }
};

export const HARNESS_SETUP = [
  "sh benchmarks/harness/node-runtime.sh 2>&1",
  'export PATH="$HOME/.local/typepeek-node/bin:$PATH"; npx --yes --package=bun@1.4.4 bun install --frozen-lockfile',
];
