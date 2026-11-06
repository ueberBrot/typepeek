import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Queue, Schema, Stream } from "effect";
import type { PlatformError, Cause } from "effect";
import { ChildProcess } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";
import { nodeProcessLayer, spawnProcess } from "#typepeek/node-process";
import { runCommand } from "#typepeek/process-command";
import { collectProcessOutput } from "#typepeek/process-output";

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

    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "protocol"],
      {
        input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
        reject: false,
      }
    );

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

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* exchangeProtocol() {
            const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();

            const responses = yield* Queue.unbounded<
              string,
              PlatformError.PlatformError | Cause.Done
            >();

            const subprocess = yield* spawnProcess(
              ChildProcess.make(process.execPath, ["src/cli.ts", "protocol"], {
                env: {
                  TYPEPEEK_CACHE_DIRECTORY: nodePath.join(
                    resolutionContext,
                    "cache"
                  ),
                },
                extendEnv: true,
                forceKillAfter: 1000,
                stdin: Stream.fromQueue(input),
              })
            );

            yield* Effect.forkChild(
              subprocess.stdout.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runIntoQueue(responses)
              )
            );

            for (const name of ["first", "second"]) {
              yield* Effect.promise(async () => {
                await writeFile(
                  declaration,
                  `export declare const ${name}: string;\n`
                );
              });
              yield* Queue.offer(input, Buffer.from(`${request}\n`));
              const response = yield* Queue.take(responses);
              expect(decodeJson(Schema.MutableJson, response)).toMatchObject({
                outcome: {
                  result: { moduleExports: [match.objectContaining({ name })] },
                  status: "success",
                },
              });
            }

            yield* Queue.end(input);

            const [exitCode, stderr] = yield* Effect.all(
              [
                subprocess.exitCode,
                collectProcessOutput(subprocess.stderr, 1024),
              ],
              { concurrency: "unbounded" }
            );

            expect([exitCode, stderr.toString()]).toStrictEqual([0, ""]);
          })
        ).pipe(Effect.timeout(10_000), Effect.provide(nodeProcessLayer))
      );
    } finally {
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
      const result = await runCommand(
        process.execPath,
        ["src/cli.ts", "protocol"],
        {
          input,
          reject: false,
        }
      );

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

    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "protocol"],
      {
        input: `${input}\n${input}`,
        reject: false,
      }
    );

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
    const result = await runCommand(
      process.execPath,
      ["src/cli.ts", "protocol"],
      {
        input: "",
      }
    );

    expect([result.stdout, result.stderr]).toStrictEqual(["", ""]);
  });

  it("stops without a stack trace when the caller closes the response pipe", async () => {
    const source = `
      import {spawn} from "node:child_process";
      import {once} from "node:events";
      import {createInterface} from "node:readline";
      const child = spawn(process.execPath, ["src/cli.ts", "protocol"], {stdio: ["pipe", "pipe", "pipe"]});
      const exited = once(child, "exit");
      let stderr = "";
      child.stderr.on("data", (chunk) => {stderr += chunk;});
      const lines = createInterface({input: child.stdout});
      child.stdin.write("{}\\n");
      await once(lines, "line");
      lines.close();
      child.stdout.destroy();
      child.stdin.end("{}\\n".repeat(100));
      const [exitCode] = await exited;
      process.stdout.write(JSON.stringify({stderr, exitCode}));
    `;

    const result = await runCommand(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { timeout: 5000 }
    );

    expect(decodeJson(Schema.MutableJson, result.stdout)).toStrictEqual({
      exitCode: 70,
      stderr: "",
    });
  });
});
