import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cpus, hostname, release } from "node:os";
import nodePath from "node:path";

import { execa } from "execa";

export interface DiscoveryIdentity {
  readonly workspace: string;
  readonly node: string;
  readonly compiler: string;
  readonly ripgrep: string;
  readonly platform: string;
  readonly architecture: string;
  readonly osRelease: string;
  readonly cpu: string;
  readonly hostname: string;
  readonly adapter: "package";
  readonly evidenceHash: string;
  readonly lockfileHash: string;
  readonly artifactHash: string;
  readonly harnessHash: string;
  readonly commit: string;
}

export const hashText = function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
};

export const requirePackagedArtifact =
  function requirePackagedArtifact(): string {
    const cli = nodePath.resolve("dist/cli.js");

    if (!existsSync(cli)) {
      throw new Error(
        "A prepacked Typepeek artifact is required. Run `vp run pack` separately first; the benchmark never builds or packs Typepeek."
      );
    }

    return cli;
  };

const hashFiles = function hashFiles(
  root: string,
  files: readonly string[]
): string {
  const hash = createHash("sha256");

  for (const file of [...new Set(files)].toSorted()) {
    hash.update(nodePath.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }

  return hash.digest("hex");
};

export const evidenceFingerprint = function evidenceFingerprint(
  workspace: string,
  files: readonly string[]
): string {
  const declarations = files.map((file) => realpathSync(file));
  const selected = new Set(declarations);

  for (const file of declarations) {
    let directory = nodePath.dirname(file);

    while (directory !== nodePath.dirname(directory)) {
      const manifest = nodePath.join(directory, "package.json");

      if (existsSync(manifest)) {
        selected.add(manifest);
      }

      directory = nodePath.dirname(directory);
    }
  }

  return hashFiles(workspace, [...selected]);
};

const sourceFiles = function sourceFiles(
  root: string,
  extension: string
): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = nodePath.join(root, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path, extension);
    }

    if (entry.isFile() && path.endsWith(extension)) {
      return [path];
    }

    return [];
  });
};

export const discoveryIdentity = async function discoveryIdentity(options: {
  readonly workspace: string;
  readonly compilerVersion: string;
  readonly evidenceHash: string;
}): Promise<DiscoveryIdentity> {
  const [git, ripgrep] = await Promise.all([
    execa("git", ["rev-parse", "HEAD"], { reject: false }),
    execa("rg", ["--version"], { reject: false }),
  ]);

  const lockfiles = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "bun.lock",
    "package.json",
  ].flatMap((name) => {
    const path = nodePath.join(options.workspace, name);

    return existsSync(path) ? [path] : [];
  });

  if (lockfiles.length < 2) {
    throw new Error(
      "The benchmark requires a consumer manifest and an installed dependency lockfile."
    );
  }

  const repository = nodePath.resolve(".");

  return {
    adapter: "package",
    architecture: process.arch,
    artifactHash: hashFiles(repository, sourceFiles("dist", ".js")),
    commit: git.stdout || "unavailable",
    compiler: options.compilerVersion,
    cpu: cpus()[0]?.model ?? "unknown",
    evidenceHash: options.evidenceHash,
    harnessHash: hashFiles(
      repository,
      sourceFiles("benchmarks/support", ".ts")
    ),
    hostname: hostname(),
    lockfileHash: hashFiles(options.workspace, lockfiles),
    node: process.version,
    osRelease: release(),
    platform: process.platform,
    ripgrep: ripgrep.failed
      ? "unavailable"
      : (ripgrep.stdout.split("\n")[0] ?? ripgrep.stdout),
    workspace: realpathSync(options.workspace),
  };
};
