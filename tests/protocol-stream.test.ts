import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vite-plus/test";

it("returns ordered protocol responses for successive request lines", async () => {
  const requests = [
    { protocolVersion: "99", intent: "interface-overview", request: {} },
    { protocolVersion: "1", intent: "interface-overview", request: {} },
  ];
  const result = await execa(process.execPath, ["src/cli.ts", "protocol", "--stream"], {
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    reject: false,
  });

  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n").map((line) => JSON.parse(line))).toMatchObject([
    { protocolVersion: "1", outcome: { reason: "unsupported-protocol-version" } },
    { protocolVersion: "1", outcome: { reason: "invalid-request" } },
  ]);
  expect(result.exitCode).toBe(1);
});

it("answers before stdin closes and reads declaration changes between requests", async () => {
  const resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-protocol-stream-"));
  const packageRoot = join(resolutionContext, "node_modules", "stream-fixture");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "stream-fixture", version: "1.0.0", types: "index.d.ts" }),
  );
  const declaration = join(packageRoot, "index.d.ts");
  const request = JSON.stringify({
    protocolVersion: "1",
    intent: "interface-overview",
    request: { resolutionContext, specifier: "stream-fixture" },
  });
  const subprocess = execa(process.execPath, ["src/cli.ts", "protocol", "--stream"], {
    env: { TYPEPEEK_CACHE_DIRECTORY: join(resolutionContext, "cache") },
    stdin: "pipe",
    reject: false,
    timeout: 10_000,
  });
  const lines = createInterface({ input: subprocess.stdout });
  const responses = lines[Symbol.asyncIterator]();
  try {
    for (const name of ["first", "second"]) {
      await writeFile(declaration, `export declare const ${name}: string;\n`);
      subprocess.stdin.write(`${request}\n`);
      const response = await responses.next();
      expect(response.done).toBe(false);
      expect(JSON.parse(response.value!)).toMatchObject({
        outcome: { status: "success", result: { moduleExports: [{ name }] } },
      });
    }
    subprocess.stdin.end();
    const result = await subprocess;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  } finally {
    lines.close();
    subprocess.kill();
    await subprocess;
    await rm(resolutionContext, { recursive: true, force: true });
  }
});

it.each([
  ["\n", "empty-input"],
  ["{\n{}\n", "malformed-json"],
  [Buffer.from([0xc3, 0x28, 0x0a]), "invalid-utf8"],
  [Buffer.alloc(32 * 1_024 + 1, 0x20), "input-too-large"],
])("ends the stream with one wire error for invalid request bytes", async (input, reason) => {
  const result = await execa(process.execPath, ["src/cli.ts", "protocol", "--stream"], {
    input,
    reject: false,
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    wireVersion: "1",
    status: "invalid-input",
    reason,
  });
});

it("applies the input limit per line and accepts a final line without a newline", async () => {
  const input = `${" ".repeat(32 * 1_024 - 2)}{}`;
  const result = await execa(process.execPath, ["src/cli.ts", "protocol", "--stream"], {
    input: `${input}\n${input}`,
    reject: false,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n").map((line) => JSON.parse(line))).toMatchObject([
    { outcome: { reason: "invalid-request" } },
    { outcome: { reason: "invalid-request" } },
  ]);
});

it("closes an empty stream without emitting a response", async () => {
  const result = await execa(process.execPath, ["src/cli.ts", "protocol", "--stream"], {
    input: "",
  });
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

it("stops without a stack trace when the caller closes the response pipe", async () => {
  const subprocess = execa(process.execPath, ["src/cli.ts", "protocol", "--stream"], {
    stdin: "pipe",
    reject: false,
    timeout: 5_000,
  });
  const lines = createInterface({ input: subprocess.stdout });
  try {
    subprocess.stdin.write("{}\n");
    await lines[Symbol.asyncIterator]().next();
    lines.close();
    subprocess.stdout.destroy();
    subprocess.stdin.end("{}\n".repeat(100));
    const result = await subprocess;
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(70);
    expect(result.timedOut).toBe(false);
  } finally {
    lines.close();
    subprocess.kill();
    await subprocess;
  }
});
