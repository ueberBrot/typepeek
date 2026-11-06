import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { execa } from "execa";

export const stageHarnessSource = async (repository: string) => {
  const root = await mkdtemp(
    nodePath.join(tmpdir(), "typepeek-sandbox-source-")
  );

  try {
    const listing = await execa("git", ["ls-files", "-z", "--cached"], {
      cwd: repository,
    });

    const hash = createHash("sha256");

    const files = [
      ...new Set(listing.stdout.split("\0").filter(Boolean)),
    ].toSorted();

    await Array.fromAsync(files, async (file) => {
      const source = nodePath.join(repository, file);
      const metadata = await lstat(source);

      if (!metadata.isFile()) {
        throw new Error(`Sandbox source must be an ordinary file: ${file}`);
      }

      const contents = await readFile(source);
      hash.update(file).update("\0").update(contents).update("\0");
      const target = nodePath.join(root, file);
      await mkdir(nodePath.dirname(target), { recursive: true });
      await writeFile(target, contents, { mode: metadata.mode % 0o1000 });
    });

    await execa("git", ["init", "--quiet", root]);
    await execa("git", ["add", "--all"], { cwd: root });
    await execa(
      "git",
      [
        "-c",
        "user.name=Typepeek Sandbox",
        "-c",
        "user.email=sandbox@typepeek.invalid",
        "commit",
        "--quiet",
        "-m",
        "Stage sandbox source",
      ],
      { cwd: root }
    );

    return {
      cleanup: async () => {
        await rm(root, { force: true, recursive: true });
      },
      directory: root,
      hash: hash.digest("hex"),
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};
