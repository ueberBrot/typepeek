import { execa } from "execa";
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
import { dirname, join, resolve } from "node:path";

import type { CodexCondition } from "./scenarios.ts";

export interface CodexFixture {
  readonly root: string;
  readonly modules: string;
  readonly toolRoot: string;
  readonly toolBin: string;
  readonly manifest: string;
  readonly codexHome: string;
  readonly cleanup: () => Promise<void>;
}

export async function createCodexFixture(): Promise<CodexFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "typepeek-codex-benchmark-")));
  try {
    const modules = join(root, "consumer", "node_modules");
    await cp(resolve("node_modules"), modules, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const original: unknown = JSON.parse(await readFile("package.json", "utf8"));
    if (
      typeof original !== "object" ||
      original === null ||
      !("dependencies" in original) ||
      !("devDependencies" in original)
    )
      throw new Error("Expected the repository package manifest.");
    const manifest = JSON.stringify(
      {
        name: "dependency-benchmark-consumer",
        private: true,
        type: "module",
        dependencies: original.dependencies,
        devDependencies: original.devDependencies,
      },
      null,
      2,
    );
    const toolRoot = join(root, "tools", "typepeek");
    const codexHome = join(root, "codex");
    await mkdir(codexHome);
    const authentication = join(
      process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
      "auth.json",
    );
    if (existsSync(authentication)) await symlink(authentication, join(codexHome, "auth.json"));
    const toolBin = join(root, "tools", "bin");
    await cp(resolve("dist"), join(toolRoot, "dist"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await cp(resolve("package.json"), join(toolRoot, "package.json"));
    await symlink(modules, join(toolRoot, "node_modules"), "dir");
    await mkdir(toolBin, { recursive: true });
    const launcher = join(toolBin, "typepeek");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(toolRoot, "dist", "cli.js"))} "$@"\n`,
      { mode: 0o755 },
    );
    await chmod(launcher, 0o755);
    return {
      root,
      modules,
      toolRoot,
      toolBin,
      manifest,
      codexHome,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createCodexTrial(
  fixture: CodexFixture,
  id: string,
  condition: CodexCondition,
) {
  const workspace = dirname(fixture.modules);
  for (const entry of await readdir(workspace)) {
    if (entry !== "node_modules")
      await rm(join(workspace, entry), { recursive: true, force: true });
  }
  const scratch = join(workspace, "scratch", id);
  await mkdir(scratch, { recursive: true });
  await writeFile(join(workspace, "package.json"), fixture.manifest);
  const path = [
    ...(condition === "files" ? [] : [fixture.toolBin]),
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((entry) => existsSync(entry))
    .join(":");
  const filesystem: Record<string, string> = {
    ":root": "deny",
    ":minimal": "read",
    ":tmpdir": "deny",
    ":slash_tmp": "deny",
    [workspace]: "write",
    [fixture.modules]: "read",
    [join(workspace, "node_modules")]: "read",
    [join(workspace, "package.json")]: "read",
  };
  for (const runtime of [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/dev",
    "/opt/homebrew",
    dirname(process.execPath),
  ]) {
    if (existsSync(runtime)) filesystem[runtime] = "read";
  }
  if (condition !== "files") {
    filesystem[fixture.toolRoot] = "read";
    filesystem[fixture.toolBin] = "read";
  }
  const inlineTable = (entries: Readonly<Record<string, string>>) =>
    `{ ${Object.entries(entries)
      .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
      .join(", ")} }`;
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
    `shell_environment_policy.set=${inlineTable({ PATH: path, TMPDIR: scratch, TYPEPEEK_CACHE_BYPASS: "1", TYPEPEEK_CACHE_DIRECTORY: join(scratch, "cache") })}`,
  ];
  return {
    workspace,
    scratch,
    path,
    configArguments: settings.flatMap((setting) => ["-c", setting]),
  };
}

export async function verifyCodexIsolation(
  fixture: CodexFixture,
  trial: Awaited<ReturnType<typeof createCodexTrial>>,
  condition: CodexCondition,
): Promise<void> {
  const protectedPaths = await repositoryEvidencePaths();
  const probe = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const readable = path => { try { fs.readFileSync(path); return true; } catch { return false; } };
    if (!fs.realpathSync(${JSON.stringify(fixture.modules)}).startsWith(fs.realpathSync(${JSON.stringify(trial.workspace)}) + require('node:path').sep)) throw new Error('installed declarations outside consumer boundary');
    if (!readable(${JSON.stringify(join(trial.workspace, "package.json"))})) throw new Error('consumer unavailable');
    for (const path of ${JSON.stringify(protectedPaths)}) {
      if (readable(path)) throw new Error('repository evidence leaked: ' + path);
    }
    if (readable(${JSON.stringify(join(fixture.toolRoot, "dist/cli.js"))}) !== ${condition !== "files"}) throw new Error('incorrect Typepeek access');
    fs.writeFileSync(${JSON.stringify(join(trial.scratch, "permission-probe"))}, 'ok');
    let couldWrite = false;
    try { fs.writeFileSync(${JSON.stringify(join(fixture.modules, ".permission-probe"))}, 'bad'); couldWrite = true; } catch {}
    if (couldWrite) throw new Error('dependencies writable');
    const found = cp.spawnSync('/bin/sh', ['-c', 'command -v typepeek'], { encoding: 'utf8', env: { PATH: ${JSON.stringify(trial.path)} } });
    if ((found.status === 0) !== ${condition !== "files"}) throw new Error('incorrect executable availability');
    console.log('isolation verified');
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
    { reject: false, timeout: 15_000, env: { CODEX_HOME: fixture.codexHome } },
  );
  if (result.exitCode !== 0 || !result.stdout.includes("isolation verified")) {
    throw new Error(
      `Codex isolation preflight failed; no model trial was started. ${result.stderr}\n${result.stdout}`,
    );
  }
}

async function repositoryEvidencePaths(): Promise<readonly string[]> {
  const listing = await execa("git", ["worktree", "list", "--porcelain", "-z"]);
  const roots = new Set([
    resolve("."),
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
    ].map((path) => join(root, path)),
  );
}
