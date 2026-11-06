import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { shellArgument } from "../../benchmarks/harness/tasks.ts";

export const createSandboxCliFixture = async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), "typepeek-sbx-fixture-"));
  const previousRoot = process.env["TYPEPEEK_SBX_FIXTURE_ROOT"];
  process.env["TYPEPEEK_SBX_FIXTURE_ROOT"] = root;
  const binary = nodePath.join(root, "sbx");
  const failCreate = nodePath.join(root, "fail-create");
  const failRemove = nodePath.join(root, "fail-remove");

  await mkdir(nodePath.join(root, "guests"));
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${shellArgument(process.execPath)} ${shellArgument(fileURLToPath(new URL("../fixtures/sandbox-cli.ts", import.meta.url)))} "$@"\n`,
    { mode: 0o755 }
  );

  return {
    binary,
    close: async () => {
      if (previousRoot === undefined) {
        delete process.env["TYPEPEEK_SBX_FIXTURE_ROOT"];
      } else {
        process.env["TYPEPEEK_SBX_FIXTURE_ROOT"] = previousRoot;
      }

      await rm(root, { force: true, recursive: true });
    },
    failCreate,
    failRemove,
    root,
  };
};
