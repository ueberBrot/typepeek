import { Effect, FileSystem, Option, Redacted } from "effect";
import type { ChildProcess } from "effect/process";

import { pathDelimiter } from "#typepeek/platform/node-path-matching";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";

const packageManagerScripts = new Map<string, readonly string[]>([
  ["npm", ["npm", "bin", "npm-cli.js"]],
  ["npx", ["npm", "bin", "npx-cli.js"]],
  ["pnpm", ["pnpm", "bin", "pnpm.cjs"]],
]);

/** Invoke package-manager entrypoints directly on Windows, without shell quoting. */
export const processExecutable = Effect.fnUntraced(function* processExecutable(
  executable: string,
  args: readonly string[],
  options: Pick<ChildProcess.CommandOptions, "cwd" | "env" | "extendEnv"> = {}
) {
  const name = executable.replace(/\.cmd$/iu, "");
  const script = packageManagerScripts.get(name);

  if (process.platform !== "win32" || script === undefined) {
    return {
      args,
      env: options.env,
      executable,
      extendEnv: options.extendEnv ?? true,
    };
  }

  const fs = yield* FileSystem.FileSystem;

  const inherited =
    options.extendEnv === false && options.env !== undefined
      ? []
      : Object.entries(process.env);

  const env = Object.fromEntries(
    [...inherited, ...Object.entries(options.env ?? {})].map(([key, value]) => [
      key.toUpperCase(),
      value,
    ])
  );

  const context = { env, extendEnv: false } as const;
  const cwd = nodePath.resolve(options.cwd ?? process.cwd());

  const childPath = env["PATH"] ?? "";

  const environmentPath = Redacted.isRedacted(childPath)
    ? Redacted.value(childPath)
    : childPath;

  for (const directory of environmentPath.split(pathDelimiter)) {
    const commandDirectory = nodePath.resolve(cwd, directory);

    const native = yield* Effect.findFirst(
      [
        nodePath.join(commandDirectory, `${name}.exe`),
        nodePath.join(commandDirectory, `${name}.native.exe`),
      ],
      fs.exists
    );

    if (Option.isSome(native)) {
      return { ...context, args, executable: native.value };
    }

    if (!(yield* fs.exists(nodePath.join(commandDirectory, `${name}.cmd`)))) {
      continue;
    }

    const candidates = [
      nodePath.join(commandDirectory, "node_modules", ...script),
      nodePath.resolve(commandDirectory, "..", ...script),
    ];

    const entry = yield* Effect.findFirst(candidates, fs.exists);

    if (Option.isSome(entry)) {
      return {
        ...context,
        args: [entry.value, ...args],
        executable: process.execPath,
      };
    }

    throw new Error(
      `Cannot resolve the package-manager entrypoint for ${name} from ${Redacted.isRedacted(childPath) ? "<redacted>" : directory}.`
    );
  }

  return { ...context, args, executable };
});
