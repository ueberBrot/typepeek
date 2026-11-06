import { existsSync } from "node:fs";
import nodePath from "node:path";

const packageManagerScripts = new Map<string, readonly string[]>([
  ["npm", ["npm", "bin", "npm-cli.js"]],
  ["npx", ["npm", "bin", "npx-cli.js"]],
  ["pnpm", ["pnpm", "bin", "pnpm.cjs"]],
]);

/** Invoke Node package-manager entrypoints directly on Windows, without shell quoting. */
export const processExecutable = (
  executable: string,
  args: readonly string[]
) => {
  const name = executable.replace(/\.cmd$/iu, "");
  const script = packageManagerScripts.get(name);

  if (process.platform !== "win32" || script === undefined) {
    return { args, executable };
  }

  const environmentPath =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "path"
    )?.[1] ?? "";

  for (const directory of environmentPath.split(nodePath.delimiter)) {
    if (!existsSync(nodePath.join(directory, `${name}.cmd`))) {
      continue;
    }

    const candidates = [
      nodePath.join(directory, "node_modules", ...script),
      nodePath.resolve(directory, "..", ...script),
    ];

    const entry = candidates.find((candidate) => existsSync(candidate));

    if (entry !== undefined) {
      return { args: [entry, ...args], executable: process.execPath };
    }

    throw new Error(
      `Cannot resolve the Node entrypoint for ${name} from ${directory}.`
    );
  }

  return { args, executable };
};
