import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createInterface } from "node:readline";

import { Schema } from "effect";
import { execa } from "execa";
import { describe, expect, it } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";

import { match } from "./helpers/matchers.ts";

describe("protocol-stream", () => {
  it("returns ordered responses and retains failures after a successful request", async () => {
    const requests = [
      { intent: "interface-overview", protocolVersion: "99", request: {} },
      {
        intent: "public-subpath-discovery",
        protocolVersion: "1",
        request: {
          resolutionContext: process.cwd(),
          specifier: "@stricli/core",
        },
      },
    ];

    const result = await execa(process.execPath, ["src/cli.ts", "protocol"], {
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      reject: false,
    });

    expect(result.stderr).toBe("");
    expect(
      result.stdout
        .split("\n")
        .map((line) => decodeJson(Schema.MutableJson, line))
    ).toMatchObject([
      {
        outcome: { reason: "unsupported-protocol-version" },
        protocolVersion: "1",
      },
      { outcome: { status: "success" }, protocolVersion: "1" },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("answers before stdin closes and reads declaration changes between requests", async () => {
    const resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-protocol-stream-")
    );

    const packageRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      "stream-fixture"
    );

    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      nodePath.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "stream-fixture",
        types: "index.d.ts",
        version: "1.0.0",
      })
    );
    const declaration = nodePath.join(packageRoot, "index.d.ts");

    const request = JSON.stringify({
      intent: "interface-overview",
      protocolVersion: "1",
      request: { resolutionContext, specifier: "stream-fixture" },
    });

    const subprocess = execa(process.execPath, ["src/cli.ts", "protocol"], {
      env: {
        TYPEPEEK_CACHE_DIRECTORY: nodePath.join(resolutionContext, "cache"),
      },
      reject: false,
      stdin: "pipe",
      timeout: 10_000,
    });

    const lines = createInterface({ input: subprocess.stdout });
    const responses = lines[Symbol.asyncIterator]();

    try {
      await Array.fromAsync(["first", "second"], async (name) => {
        await writeFile(declaration, `export declare const ${name}: string;\n`);
        subprocess.stdin.write(`${request}\n`);
        const response = await responses.next();
        expect([
          Boolean(response.done),
          decodeJson(Schema.MutableJson, requireDefined(response.value)),
        ]).toStrictEqual([
          false,
          match.objectContaining({
            outcome: match.objectContaining({
              result: match.objectContaining({
                moduleExports: [match.objectContaining({ name })],
              }),
              status: "success",
            }),
          }),
        ]);
      });

      subprocess.stdin.end();
      const result = await subprocess;
      expect([result.exitCode, result.stderr]).toStrictEqual([0, ""]);
    } finally {
      lines.close();
      subprocess.kill();
      await subprocess;
      await rm(resolutionContext, { force: true, recursive: true });
    }
  });

  it.each([
    ["\n", "empty-input"],
    ["{\n{}\n", "malformed-json"],
    [Buffer.from([0xc3, 0x28, 0x0a]), "invalid-utf8"],
    [Buffer.alloc(32 * 1024 + 1, 0x20), "input-too-large"],
  ])(
    "ends the stream with one wire error for invalid request bytes",
    async (input, reason) => {
      const result = await execa(process.execPath, ["src/cli.ts", "protocol"], {
        input,
        reject: false,
      });

      expect([
        result.exitCode,
        result.stderr,
        decodeJson(Schema.MutableJson, result.stdout),
      ]).toStrictEqual([
        2,
        "",
        match.objectContaining({
          reason,
          status: "invalid-input",
          wireVersion: "1",
        }),
      ]);
    }
  );

  it("applies the input limit per line and accepts a final line without a newline", async () => {
    const input = `${" ".repeat(32 * 1024 - 2)}{}`;

    const result = await execa(process.execPath, ["src/cli.ts", "protocol"], {
      input: `${input}\n${input}`,
      reject: false,
    });

    expect([result.exitCode, result.stderr]).toStrictEqual([1, ""]);
    expect(
      result.stdout
        .split("\n")
        .map((line) => decodeJson(Schema.MutableJson, line))
    ).toMatchObject([
      { outcome: { reason: "invalid-request" } },
      { outcome: { reason: "invalid-request" } },
    ]);
  });

  it("closes an empty stream without emitting a response", async () => {
    const result = await execa(process.execPath, ["src/cli.ts", "protocol"], {
      input: "",
    });

    expect([result.stdout, result.stderr]).toStrictEqual(["", ""]);
  });

  it("stops without a stack trace when the caller closes the response pipe", async () => {
    const subprocess = execa(process.execPath, ["src/cli.ts", "protocol"], {
      reject: false,
      stdin: "pipe",
      timeout: 5000,
    });

    const lines = createInterface({ input: subprocess.stdout });

    try {
      subprocess.stdin.write("{}\n");
      await lines[Symbol.asyncIterator]().next();
      lines.close();
      subprocess.stdout.destroy();
      subprocess.stdin.end("{}\n".repeat(100));
      const result = await subprocess;
      expect([result.stderr, result.exitCode, result.timedOut]).toStrictEqual([
        "",
        70,
        false,
      ]);
    } finally {
      lines.close();
      subprocess.kill();
      await subprocess;
    }
  });
});
