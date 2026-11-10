import { Effect, FileSystem, Option } from "effect";

import { pathDelimiter } from "#typepeek/platform/node-path-matching";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";

const packageManagerScripts = new Map<string, readonly string[]>([
  ["npm", ["npm", "bin", "npm-cli.js"]],
  ["npx", ["npm", "bin", "npx-cli.js"]],
  ["pnpm", ["pnpm", "bin", "pnpm.cjs"]],
]);

export const processExecutable = Effect.fnUntraced(function* processExecutable(
  executable: string,
  args: readonly string[]
) {
  const name = executable.replace(/\.cmd$/iu, "");
  const script = packageManagerScripts.get(name);

  if (process.platform !== "win32" || script === undefined) {
    return { args, executable };
  }

  const fs = yield* FileSystem.FileSystem;

  const environmentPath =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "path"
    )?.[1] ?? "";

  for (const directory of environmentPath.split(pathDelimiter)) {
    const native = yield* Effect.findFirst(
      [
        nodePath.join(directory, `${name}.exe`),
        nodePath.join(directory, `${name}.native.exe`),
      ],
      fs.exists
    );

    if (Option.isSome(native)) {
      return { args, executable: native.value };
    }

    if (!(yield* fs.exists(nodePath.join(directory, `${name}.cmd`)))) {
      continue;
    }

    const candidates = [
      nodePath.join(directory, "node_modules", ...script),
      nodePath.resolve(directory, "..", ...script),
    ];

    const entry = yield* Effect.findFirst(candidates, fs.exists);

    if (Option.isSome(entry)) {
      return { args: [entry.value, ...args], executable: process.execPath };
    }

    throw new Error(
      `Cannot resolve the package-manager entrypoint for ${name} from ${directory}.`
    );
  }

  return { args, executable };
});
