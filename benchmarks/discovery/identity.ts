import { execa } from "execa";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cpus, hostname, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { inspectWithCompiler } from "./compiler.ts";
import type { DiscoveryIdentity } from "./report.ts";
import type { DiscoveryWorkload } from "./workloads.ts";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function requirePackagedArtifact(): string {
  const cli = resolve("dist/cli.js");
  if (!existsSync(cli)) {
    throw new Error(
      "A prepacked Typepeek artifact is required. Run `vp run pack` separately first; the benchmark never builds or packs Typepeek.",
    );
  }
  return cli;
}

export function evidenceFingerprint(workspace: string, files: readonly string[]): string {
  const declarations = files.map((file) => realpathSync(file));
  const selected = new Set(declarations);
  for (const file of declarations) {
    let directory = dirname(file);
    while (directory !== dirname(directory)) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) selected.add(manifest);
      directory = dirname(directory);
    }
  }
  return hashFiles(workspace, [...selected]);
}

export function currentEvidenceFingerprint(
  workspace: string,
  workloads: readonly DiscoveryWorkload[],
): string {
  return evidenceFingerprint(
    workspace,
    workloads.flatMap((workload) => inspectWithCompiler(workspace, workload).files),
  );
}

export async function discoveryIdentity(options: {
  readonly workspace: string;
  readonly compilerVersion: string;
  readonly evidenceHash: string;
}): Promise<DiscoveryIdentity> {
  const [git, ripgrep] = await Promise.all([
    execa("git", ["rev-parse", "HEAD"], { reject: false }),
    execa("rg", ["--version"]),
  ]);
  const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "bun.lock", "package.json"]
    .map((name) => join(options.workspace, name))
    .filter(existsSync);
  if (lockfiles.length < 2) {
    throw new Error(
      "The benchmark requires a consumer manifest and an installed dependency lockfile.",
    );
  }
  const repository = resolve(".");
  return {
    workspace: realpathSync(options.workspace),
    node: process.version,
    compiler: options.compilerVersion,
    ripgrep: ripgrep.stdout.split("\n")[0] ?? ripgrep.stdout,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    hostname: hostname(),
    adapter: "package",
    evidenceHash: options.evidenceHash,
    lockfileHash: hashFiles(options.workspace, lockfiles),
    artifactHash: hashFiles(repository, sourceFiles("dist", ".js")),
    harnessHash: hashFiles(repository, sourceFiles("benchmarks/discovery", ".ts")),
    commit: git.stdout || "unavailable",
  };
}

function sourceFiles(root: string, extension: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path, extension)
      : entry.isFile() && path.endsWith(extension)
        ? [path]
        : [];
  });
}

function hashFiles(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
