import { createRequire } from "node:module";
import nodePath from "node:path";

import { version } from "tsrs";

import { runCommand } from "#typepeek/platform/process-command";

const launcher = nodePath.join(
  nodePath.dirname(
    createRequire(import.meta.url).resolve("@effect/tsgo/package.json")
  ),
  "dist/effect-tsgo.cjs"
);

// The public diagnostics command requires a standalone TypeScript package;
// the pinned TSRS build accepts the same diagnostics protocol directly.
const result = await runCommand(
  process.execPath,
  [
    launcher,
    `tsrs@${version}`,
    "--effect-cli-diagnostics",
    JSON.stringify({
      cwd: process.cwd(),
      format: "text",
      project: "tsconfig.json",
      strict: true,
    }),
  ],
  { reject: false, stderr: "inherit", stdin: "inherit", stdout: "inherit" }
);

process.exitCode = result.exitCode ?? 1;
