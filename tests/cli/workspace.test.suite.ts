import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";
import { runCommand } from "#typepeek/process-command";

import { match } from "../helpers/matchers.ts";

export const registerWorkspaceTests = function registerWorkspaceTests(): void {
  test.each([
    "./packages/*",
    "@(packages|apps)/*",
    "+(packages)/*",
    "packages/!(excluded)",
  ])(
    "infers the only workspace that declares a package using %s",
    async (workspacePattern) => {
      const repositoryRoot = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-cli-workspace-inference-")
      );

      const workspaceRoot = nodePath.join(
        repositoryRoot,
        "packages",
        "consumer"
      );

      const packageRoot = nodePath.join(
        workspaceRoot,
        "node_modules",
        "workspace-only-package"
      );

      await Promise.all([
        mkdir(packageRoot, { recursive: true }),
        writeFile(
          nodePath.join(repositoryRoot, "package.json"),
          JSON.stringify({ private: true, workspaces: [workspacePattern] })
        ),
      ]);
      await Promise.all([
        writeFile(
          nodePath.join(workspaceRoot, "package.json"),
          JSON.stringify({
            dependencies: { "workspace-only-package": "1.0.0" },
            name: "workspace-consumer",
            private: true,
          })
        ),
        writeFile(
          nodePath.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "workspace-only-package",
            types: "./index.d.ts",
            version: "1.0.0",
          })
        ),
        writeFile(
          nodePath.join(packageRoot, "index.d.ts"),
          "export declare const workspaceValue: string;\n"
        ),
      ]);

      try {
        const result = await runCommand(
          process.execPath,
          [
            nodePath.join(process.cwd(), "src/cli.ts"),
            "workspace-only-package",
            "--json",
          ],
          { cwd: repositoryRoot, reject: false }
        );

        expect([
          result.exitCode,
          result.stderr,
          decodeJson(Schema.MutableJson, result.stdout),
        ]).toStrictEqual([
          0,
          "",
          match.objectContaining({
            result: match.objectContaining({
              moduleExports: [
                match.objectContaining({ name: "workspaceValue" }),
              ],
              packageIdentity: match.objectContaining({
                name: "workspace-only-package",
                version: "1.0.0",
              }),
            }),
            status: "success",
          }),
        ]);
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    }
  );

  test.each([
    [
      "indented sequence",
      "packages:\n  - 'packages/*' # consuming \"workspaces\"\n",
    ],
    [
      "indentless sequence",
      "packages:\n- 'packages/*' # consuming \"workspaces\"\n",
    ],
    ["commented key", "packages: # consuming workspaces\n  - 'packages/*'\n"],
  ])(
    "infers a declared pnpm workspace using %s",
    async (_description, workspaceConfig) => {
      const repositoryRoot = await mkdtemp(
        nodePath.join(tmpdir(), "typepeek-cli-pnpm-workspace-")
      );

      const workspaceRoot = nodePath.join(
        repositoryRoot,
        "packages",
        "consumer"
      );

      const packageRoot = nodePath.join(
        workspaceRoot,
        "node_modules",
        "pnpm-workspace-package"
      );

      const ignoredWorkspaceRoot = nodePath.join(
        repositoryRoot,
        "ignored",
        "consumer"
      );

      await mkdir(packageRoot, { recursive: true });
      await mkdir(ignoredWorkspaceRoot, { recursive: true });
      await Promise.all([
        writeFile(
          nodePath.join(repositoryRoot, "package.json"),
          JSON.stringify({ private: true })
        ),
        writeFile(
          nodePath.join(repositoryRoot, "pnpm-workspace.yaml"),
          `${workspaceConfig}onlyBuiltDependencies:\n  - 'ignored/*'\n`
        ),
        writeFile(
          nodePath.join(ignoredWorkspaceRoot, "package.json"),
          JSON.stringify({
            dependencies: { "pnpm-workspace-package": "1.0.0" },
            name: "ignored-consumer",
            private: true,
          })
        ),
        writeFile(
          nodePath.join(workspaceRoot, "package.json"),
          JSON.stringify({
            dependencies: { "pnpm-workspace-package": "1.0.0" },
            name: "pnpm-workspace-consumer",
            private: true,
          })
        ),
        writeFile(
          nodePath.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "pnpm-workspace-package",
            types: "./index.d.ts",
            version: "1.0.0",
          })
        ),
        writeFile(
          nodePath.join(packageRoot, "index.d.ts"),
          "export declare const pnpmValue: string;\n"
        ),
      ]);

      try {
        const result = await runCommand(
          process.execPath,
          [
            nodePath.join(process.cwd(), "src/cli.ts"),
            "pnpm-workspace-package",
            "--json",
          ],
          { cwd: repositoryRoot, reject: false }
        );

        expect([
          result.exitCode,
          decodeJson(Schema.MutableJson, result.stdout),
        ]).toStrictEqual([
          0,
          match.objectContaining({
            result: match.objectContaining({
              moduleExports: [match.objectContaining({ name: "pnpmValue" })],
            }),
            status: "success",
          }),
        ]);
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    }
  );

  test("resolves an undeclared hoisted package from the monorepo root", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cli-hoisted-package-")
    );

    const workspaceRoot = nodePath.join(repositoryRoot, "packages", "consumer");

    const packageRoot = nodePath.join(
      repositoryRoot,
      "node_modules",
      "hoisted-transitive-package"
    );

    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(packageRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        nodePath.join(repositoryRoot, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] })
      ),
      writeFile(
        nodePath.join(workspaceRoot, "package.json"),
        JSON.stringify({ name: "hoisted-consumer", private: true })
      ),
      writeFile(
        nodePath.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "hoisted-transitive-package",
          types: "./index.d.ts",
          version: "1.0.0",
        })
      ),
      writeFile(
        nodePath.join(packageRoot, "index.d.ts"),
        "export declare const hoistedValue: string;\n"
      ),
    ]);

    try {
      const result = await runCommand(
        process.execPath,
        [
          nodePath.join(process.cwd(), "src/cli.ts"),
          "hoisted-transitive-package",
          "--json",
        ],
        { cwd: repositoryRoot, reject: false }
      );

      expect([
        result.exitCode,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        0,
        match.objectContaining({
          result: match.objectContaining({
            moduleExports: [match.objectContaining({ name: "hoistedValue" })],
          }),
          status: "success",
        }),
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reports bounded workspace discovery when a workspace manifest is oversized", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cli-workspace-limit-")
    );

    await writeFile(
      nodePath.join(repositoryRoot, "package.json"),
      JSON.stringify({ padding: "x".repeat(256 * 1024), private: true })
    );

    try {
      const result = await runCommand(
        process.execPath,
        [
          nodePath.join(process.cwd(), "src/cli.ts"),
          "oversized-workspace-package",
          "--json",
        ],
        { cwd: repositoryRoot, reject: false }
      );

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        {
          message:
            "Workspace discovery exceeded its bound. Select one with --workspace <path>.",
          status: "invalid-invocation",
        },
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("reports bounded workspace discovery when ancestor traversal is exhausted", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cli-ancestor-limit-")
    );

    const nestedDirectory = nodePath.join(
      repositoryRoot,
      ...Array.from({ length: 64 }, (_, index) => `level-${index}`)
    );

    await Promise.all([
      mkdir(nestedDirectory, { recursive: true }),
      writeFile(
        nodePath.join(repositoryRoot, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] })
      ),
    ]);

    try {
      const result = await runCommand(
        process.execPath,
        [
          nodePath.join(process.cwd(), "src/cli.ts"),
          "ancestor-limit-package",
          "--json",
        ],
        { cwd: nestedDirectory, reject: false }
      );

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        {
          message:
            "Workspace discovery exceeded its bound. Select one with --workspace <path>.",
          status: "invalid-invocation",
        },
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("requires --workspace when several workspaces declare a package", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cli-workspace-ambiguity-")
    );

    const packageRoots = ["consumer-one", "consumer-two"].map((workspace) =>
      nodePath.join(
        repositoryRoot,
        "packages",
        workspace,
        "node_modules",
        "shared-package"
      )
    );

    const workspaceRoots = packageRoots.map((packageRoot) =>
      nodePath.dirname(nodePath.dirname(packageRoot))
    );

    await Promise.all(
      packageRoots.map(
        async (packageRoot) => await mkdir(packageRoot, { recursive: true })
      )
    );
    await Promise.all([
      writeFile(
        nodePath.join(repositoryRoot, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] })
      ),
      ...workspaceRoots.map(async (workspaceRoot, index) => {
        await writeFile(
          nodePath.join(workspaceRoot, "package.json"),
          JSON.stringify({
            dependencies: { "shared-package": "1.0.0" },
            name: `consumer-${index + 1}`,
            private: true,
          })
        );
      }),
      ...packageRoots.map(async (packageRoot) => {
        await writeFile(
          nodePath.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "shared-package",
            types: "./index.d.ts",
            version: "1.0.0",
          })
        );
      }),
    ]);

    try {
      const result = await runCommand(
        process.execPath,
        [
          nodePath.join(process.cwd(), "src/cli.ts"),
          "shared-package",
          "--json",
        ],
        { cwd: repositoryRoot, reject: false }
      );

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        {
          message:
            'Specifier "shared-package" matches multiple consuming workspaces: packages/consumer-one, packages/consumer-two. Select one with --workspace <path>.',
          status: "invalid-invocation",
        },
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("does not infer a sibling when invoked from within a workspace", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-cli-workspace-scope-")
    );

    const currentWorkspace = nodePath.join(
      repositoryRoot,
      "packages",
      "current"
    );

    const siblingWorkspace = nodePath.join(
      repositoryRoot,
      "packages",
      "sibling"
    );

    const packageRoot = nodePath.join(
      siblingWorkspace,
      "node_modules",
      "sibling-only-package"
    );

    await Promise.all([
      mkdir(currentWorkspace, { recursive: true }),
      mkdir(packageRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        nodePath.join(repositoryRoot, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] })
      ),
      writeFile(
        nodePath.join(currentWorkspace, "package.json"),
        JSON.stringify({ name: "current-workspace", private: true })
      ),
      writeFile(
        nodePath.join(siblingWorkspace, "package.json"),
        JSON.stringify({
          dependencies: { "sibling-only-package": "1.0.0" },
          name: "sibling-workspace",
          private: true,
        })
      ),
      writeFile(
        nodePath.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "sibling-only-package",
          types: "./index.d.ts",
          version: "1.0.0",
        })
      ),
      writeFile(
        nodePath.join(packageRoot, "index.d.ts"),
        "export declare const siblingValue: string;\n"
      ),
    ]);

    try {
      const result = await runCommand(
        process.execPath,
        [
          nodePath.join(process.cwd(), "src/cli.ts"),
          "sibling-only-package",
          "--json",
        ],
        { cwd: currentWorkspace, reject: false }
      );

      expect([
        result.exitCode,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        1,
        match.objectContaining({
          reason: "specifier-not-found",
          status: "not-found",
        }),
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
};
