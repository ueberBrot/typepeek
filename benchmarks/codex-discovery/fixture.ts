import { constants, existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";

import { Predicate, Schema } from "effect";
import { execa } from "execa";

import { decodeJson } from "#typepeek/json-data";

import type { CodexCondition } from "./scenarios.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const inlineTable = (entries: Readonly<Record<string, string>>) =>
  `{ ${Object.entries(entries)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(", ")} }`;

interface FilesystemPermissions {
  [path: string]: "read" | "write" | "deny";
}

const PACKAGE_MANIFEST_FILE = "package.json";

export interface CodexFixture {
  readonly codexExecutable: string;
  readonly root: string;
  readonly modules: string;
  readonly toolRoot: string;
  readonly toolBin: string;
  readonly manifest: string;
  readonly codexHome: string;
  readonly cleanup: () => Promise<void>;
}

export const createCodexFixture =
  async function createCodexFixture(): Promise<CodexFixture> {
    const dockerManaged = process.env["TYPEPEEK_DOCKER_CODEX"] === "true";
    const managedCodexHome = process.env["CODEX_HOME"];
    let fixtureDirectory = tmpdir();

    if (dockerManaged) {
      if (
        process.platform !== "linux" ||
        managedCodexHome === undefined ||
        !nodePath.isAbsolute(managedCodexHome)
      ) {
        throw new Error(
          "Docker Codex routing requires the managed Linux Codex home."
        );
      }

      fixtureDirectory = nodePath.join(
        homedir(),
        ".local",
        "state",
        "typepeek-benchmarks"
      );
      await mkdir(fixtureDirectory, { mode: 0o700, recursive: true });
    }

    const root = await realpath(
      await mkdtemp(
        nodePath.join(fixtureDirectory, "typepeek-codex-benchmark-")
      )
    );

    try {
      const executable = await execa("/bin/sh", ["-c", "command -v codex"]);
      const codexExecutable = await realpath(executable.stdout.trim());
      const modules = nodePath.join(root, "consumer", "node_modules");
      await cp(nodePath.resolve("node_modules"), modules, {
        mode: constants.COPYFILE_FICLONE,
        recursive: true,
        verbatimSymlinks: true,
      });

      const original = decodeJson(
        Schema.MutableJson,
        await readFile(PACKAGE_MANIFEST_FILE, "utf-8")
      );

      if (
        !Predicate.isObjectOrArray(original) ||
        !("dependencies" in original) ||
        !("devDependencies" in original)
      ) {
        throw new Error("Expected the repository package manifest.");
      }

      const manifest = JSON.stringify(
        {
          dependencies: original.dependencies,
          devDependencies: original.devDependencies,
          name: "dependency-benchmark-consumer",
          private: true,
          type: "module",
        },
        null,
        2
      );

      const toolRoot = nodePath.join(root, "tools", "typepeek");
      const codexHome = nodePath.join(root, "codex");
      await mkdir(codexHome);

      if (dockerManaged) {
        if (managedCodexHome === undefined) {
          throw new Error("Docker must provide its managed Codex home.");
        }

        await symlink(
          nodePath.join(managedCodexHome, "config.toml"),
          nodePath.join(codexHome, "config.toml")
        );
      }

      const authentication = nodePath.join(
        process.env["CODEX_HOME"] ?? nodePath.join(homedir(), ".codex"),
        "auth.json"
      );

      if (existsSync(authentication)) {
        await symlink(authentication, nodePath.join(codexHome, "auth.json"));
      }

      const toolBin = nodePath.join(root, "tools", "bin");
      await cp(nodePath.resolve("dist"), nodePath.join(toolRoot, "dist"), {
        mode: constants.COPYFILE_FICLONE,
        recursive: true,
      });
      await cp(
        nodePath.resolve(PACKAGE_MANIFEST_FILE),
        nodePath.join(toolRoot, PACKAGE_MANIFEST_FILE)
      );
      await symlink(modules, nodePath.join(toolRoot, "node_modules"), "dir");
      await mkdir(toolBin, { recursive: true });
      const launcher = nodePath.join(toolBin, "typepeek");

      await writeFile(
        launcher,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nodePath.join(toolRoot, "dist", "cli.js"))} "$@"\n`,
        { mode: 0o755 }
      );
      await chmod(launcher, 0o755);

      return {
        cleanup: async () => {
          await rm(root, { force: true, recursive: true });
        },
        codexExecutable,
        codexHome,
        manifest,
        modules,
        root,
        toolBin,
        toolRoot,
      };
    } catch (error) {
      await rm(root, { force: true, recursive: true });
      throw error;
    }
  };

export const createCodexTrial = async function createCodexTrial(
  fixture: CodexFixture,
  id: string,
  condition: CodexCondition
) {
  const workspace = nodePath.dirname(fixture.modules);
  await Array.fromAsync(await readdir(workspace), async (entry) => {
    if (entry !== "node_modules") {
      await rm(nodePath.join(workspace, entry), {
        force: true,
        recursive: true,
      });
    }
  });
  const scratch = nodePath.join(workspace, "scratch", id);
  await mkdir(scratch, { recursive: true });
  await writeFile(
    nodePath.join(workspace, PACKAGE_MANIFEST_FILE),
    fixture.manifest
  );

  const path = [
    ...(condition === "files" ? [] : [fixture.toolBin]),
    nodePath.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((entry) => existsSync(entry))
    .join(":");

  const filesystem: FilesystemPermissions = {
    ":minimal": "read",
    ":root": "deny",
    ":slash_tmp": "deny",
    [tmpdir()]: "deny",
    [fixture.modules]: "read",
    [nodePath.join(workspace, "node_modules")]: "read",
    [nodePath.join(workspace, PACKAGE_MANIFEST_FILE)]: "read",
    [workspace]: "write",
  };

  for (const runtime of [
    fixture.codexExecutable,
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/dev",
    "/opt/homebrew",
    nodePath.dirname(process.execPath),
  ]) {
    if (existsSync(runtime)) {
      filesystem[runtime] = "read";
    }
  }

  if (condition !== "files") {
    filesystem[fixture.toolRoot] = "read";
    filesystem[fixture.toolBin] = "read";
  }

  const settings = [
    'default_permissions="discovery"',
    `permissions.discovery.filesystem=${inlineTable(filesystem)}`,
    "permissions.discovery.network.enabled=false",
    'approval_policy="never"',
    'web_search="disabled"',
    "allow_login_shell=false",
    "project_doc_max_bytes=0",
    "mcp_servers={}",
    "agents.enabled=false",
    "features.multi_agent=false",
    "features.apps=false",
    "features.plugins=false",
    "features.remote_plugin=false",
    "features.hooks=false",
    "features.browser_use=false",
    "features.computer_use=false",
    "features.in_app_browser=false",
    "features.image_generation=false",
    "features.memories=false",
    "features.context_management=false",
    "tool_output_token_limit=262144",
    "features.shell_snapshot=false",
    "features.skill_search=false",
    "features.skip_host_skill_discovery=true",
    'shell_environment_policy.inherit="none"',
    `shell_environment_policy.set=${inlineTable({ PATH: path, TMPDIR: scratch, TYPEPEEK_CACHE_BYPASS: "1", TYPEPEEK_CACHE_DIRECTORY: nodePath.join(scratch, "cache") })}`,
  ];

  return {
    configArguments: settings.flatMap((setting) => ["-c", setting]),
    path,
    scratch,
    workspace,
  };
};

const repositoryEvidencePaths =
  async function repositoryEvidencePaths(): Promise<readonly string[]> {
    const listing = await execa("git", [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);

    const roots = new Set([
      nodePath.resolve("."),
      ...listing.stdout
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => field.slice("worktree ".length)),
    ]);

    return [...roots].flatMap((root) =>
      [
        "benchmarks/support/compiler.ts",
        "benchmarks/discovery/compiler.ts",
        "benchmarks/codex-discovery/acquisition.ts",
        "src/cli.ts",
      ].map((path) => nodePath.join(root, path))
    );
  };

export const verifyCodexIsolation = async function verifyCodexIsolation(
  fixture: CodexFixture,
  trial: Awaited<ReturnType<typeof createCodexTrial>>,
  condition: CodexCondition
): Promise<void> {
  const protectedPaths = await repositoryEvidencePaths();

  const probe = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const readable = path => { try { fs.readFileSync(path); return true; } catch { return false; } };
    if (!fs.realpathSync(${JSON.stringify(fixture.modules)}).startsWith(fs.realpathSync(${JSON.stringify(trial.workspace)}) + require('node:path').sep)) throw new Error('installed declarations outside consumer boundary');
    if (!readable(${JSON.stringify(nodePath.join(trial.workspace, PACKAGE_MANIFEST_FILE))})) throw new Error('consumer unavailable');
    for (const path of ${JSON.stringify(protectedPaths)}) {
      if (readable(path)) throw new Error('repository evidence leaked: ' + path);
    }
    if (readable(${JSON.stringify(nodePath.join(fixture.toolRoot, "dist/cli.js"))}) !== ${condition !== "files"}) throw new Error('incorrect Typepeek access');
    fs.writeFileSync(${JSON.stringify(nodePath.join(trial.scratch, "permission-probe"))}, 'ok');
    let couldWrite = false;
    try { fs.writeFileSync(${JSON.stringify(nodePath.join(fixture.modules, ".permission-probe"))}, 'bad'); couldWrite = true; } catch {}
    if (couldWrite) throw new Error('dependencies writable');
    const found = cp.spawnSync('/bin/sh', ['-c', 'command -v typepeek'], { encoding: 'utf8', env: { PATH: ${JSON.stringify(trial.path)} } });
    if ((found.status === 0) !== ${condition !== "files"}) throw new Error('incorrect executable availability');
    fs.writeSync(1, 'isolation verified\\n');
  `;

  const result = await execa(
    "codex",
    [
      "sandbox",
      "--permission-profile",
      "discovery",
      "--include-managed-config",
      "--cd",
      trial.workspace,
      ...trial.configArguments,
      process.execPath,
      "-e",
      probe,
    ],
    { env: { CODEX_HOME: fixture.codexHome }, reject: false, timeout: 15_000 }
  );

  if (result.exitCode !== 0 || !result.stdout.includes("isolation verified")) {
    throw new Error(
      `Codex isolation preflight failed; no model trial was started. ${result.stderr}\n${result.stdout}`
    );
  }
};
