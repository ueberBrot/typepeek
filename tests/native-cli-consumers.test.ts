import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";
import { decodeJson } from "#typepeek/shared/json-data";

import {
  installDeclaredPackages,
  localPackageSpecifier,
  PACKAGE_MANAGER_PINS,
} from "./helpers/package-toolchain.ts";

const nativePackage = process.env["TYPEPEEK_NATIVE_PACKAGE"];
const launcherPackage = process.env["TYPEPEEK_LAUNCHER_PACKAGE"];
const nativeName = process.env["TYPEPEEK_NATIVE_NAME"];

describe
  .skipIf(
    nativePackage === undefined ||
      launcherPackage === undefined ||
      nativeName === undefined
  )
  .each(
    PACKAGE_MANAGER_PINS.filter(
      (pin) =>
        process.env["TYPEPEEK_NATIVE_MANAGER"] === undefined ||
        pin.manager === process.env["TYPEPEEK_NATIVE_MANAGER"]
    )
  )("$manager native package consumer", (packageManager) => {
  let workspace: string;
  let executable: string;
  let launcher: string;

  beforeAll(async () => {
    if (
      nativePackage === undefined ||
      launcherPackage === undefined ||
      nativeName === undefined
    ) {
      throw new Error("The native package tarball is required.");
    }

    workspace = await mkdtemp(nodePath.join(tmpdir(), "typepeek native cli-"));
    await writeFile(
      nodePath.join(workspace, "package.json"),
      JSON.stringify({
        dependencies: {
          [nativeName]: localPackageSpecifier(nodePath.resolve(nativePackage)),
          typepeek: localPackageSpecifier(nodePath.resolve(launcherPackage)),
        },
        private: true,
      })
    );
    await installDeclaredPackages({
      cacheRoot: workspace,
      diagnosticContext: `${packageManager.manager} native package installation`,
      offline: false,
      packageManager,
      resolutionContext: workspace,
    });

    const target = nodePath.join(workspace, "node_modules", "native-target");
    await mkdir(target, { recursive: true });
    await writeFile(
      nodePath.join(target, "package.json"),
      JSON.stringify({
        main: "index.js",
        name: "native-target",
        types: "index.d.ts",
        version: "1.0.0",
      })
    );
    await writeFile(
      nodePath.join(target, "index.d.ts"),
      "export declare function format(value: number): string;"
    );
    await writeFile(
      nodePath.join(target, "index.js"),
      "throw new Error('Inspected runtime code must never execute');"
    );
    await writeFile(
      nodePath.join(workspace, "bunfig.toml"),
      '[run]\npreload = ["./preload.js"]\n'
    );
    await writeFile(
      nodePath.join(workspace, "preload.js"),
      "throw new Error('Workspace Bun preloads must never execute');"
    );
    executable = nodePath.join(
      workspace,
      "node_modules",
      nativeName,
      "dist",
      process.platform === "win32" ? "typepeek.exe" : "typepeek"
    );
    launcher = nodePath.join(
      workspace,
      "node_modules",
      "typepeek",
      "dist",
      "launcher.js"
    );
  }, 180_000);

  afterAll(async () => {
    if (workspace !== undefined) {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("runs installed signatures and cached results without a JavaScript runtime", async () => {
    const options = {
      cwd: workspace,
      env: process.platform === "win32" ? {} : { PATH: "/usr/bin:/bin" },
      timeout: 30_000,
    };

    const args = ["signatures", "native-target", "format", "--json"];
    const first = await runCommand(executable, args, options);
    const cached = await runCommand(executable, args, options);

    expect(first).toMatchObject({ exitCode: 0, stderr: "", timedOut: false });
    expect(decodeJson(Schema.MutableJson, first.stdout)).toMatchObject({
      result: {
        moduleExport: {
          name: "format",
          signatures: [{ text: "(value: number): string" }],
        },
      },
      status: "success",
    });
    expect(cached).toStrictEqual(first);
    await expect(
      access(
        nodePath.join(
          workspace,
          "node_modules",
          nativeName ?? "",
          "dist",
          process.platform === "win32"
            ? "typepeek-analysis.exe"
            : "typepeek-analysis"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("launches the matching native package with npm, pnpm, or Bun", async () => {
    const args = ["signatures", "native-target", "format", "--json"];
    const expected = await runCommand(executable, args, { cwd: workspace });

    const actual = await runCommand(process.execPath, [launcher, ...args], {
      cwd: workspace,
    });

    expect(actual).toStrictEqual(expected);

    const manifest = decodeJson(
      Schema.Struct({
        optionalDependencies: Schema.Record(Schema.String, Schema.String),
      }),
      await readFile(
        nodePath.join(workspace, "node_modules", "typepeek", "package.json"),
        "utf-8"
      )
    );

    await Promise.all(
      Object.keys(manifest.optionalDependencies)
        .filter((name) => name !== nativeName)
        .map(async (name) => {
          await expect(
            access(nodePath.join(workspace, "node_modules", name))
          ).rejects.toThrow("ENOENT");
        })
    );

    const npx = await runCommand("npx", ["--no-install", "typepeek", ...args], {
      cwd: workspace,
    });

    expect(npx.stdout).toBe(expected.stdout);

    const invalid = await runCommand(
      process.execPath,
      [launcher, "--invalid-option"],
      { cwd: workspace, reject: false }
    );

    expect(invalid.exitCode).toBe(2);
  });

  it("rejects a missing installed native payload instead of using JavaScript", async () => {
    const moved = `${executable}.disabled`;
    await rename(executable, moved);

    try {
      const result = await runCommand(
        process.execPath,
        [launcher, "--version"],
        { cwd: workspace, reject: false }
      );

      expect(result.exitCode).toBe(1);
    } finally {
      await rename(moved, executable);
    }
  });

  it("preserves protocol failures and invalid argument exit statuses", async () => {
    const options = { cwd: workspace, reject: false, timeout: 30_000 };

    const missing = await runCommand(executable, ["protocol"], {
      ...options,
      input: JSON.stringify({
        intent: "signature-inspection",
        protocolVersion: "1",
        request: {
          exportName: "missing",
          resolutionContext: workspace,
          specifier: "native-target",
        },
      }),
    });

    const invalid = await runCommand(executable, ["--invalid-option"], options);

    expect(missing).toMatchObject({
      exitCode: 1,
      stderr: "",
      timedOut: false,
    });
    expect(decodeJson(Schema.MutableJson, missing.stdout)).toMatchObject({
      outcome: { reason: "export-not-found", status: "not-found" },
      protocolVersion: "1",
    });
    expect(invalid).toMatchObject({
      exitCode: 2,
      stdout: "",
      timedOut: false,
    });
  });
});
