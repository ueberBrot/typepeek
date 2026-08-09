import { execa } from "execa";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StaticInspection {
  readonly run: (options: {
    readonly adapter:
      | { readonly kind: "installed"; readonly executablePath: string }
      | { readonly kind: "source-checkout"; readonly sourceCheckout: string };
    readonly arguments_: readonly string[];
    readonly diagnosticContext: string;
    readonly resolutionContext: string;
  }) => Promise<{ readonly stdout: string }>;
  readonly verifyNoIo: () => Promise<void>;
}

export async function materializeStaticInspection(fixtureRoot: string): Promise<StaticInspection> {
  const preloadPath = join(fixtureRoot, "inspection-tripwire.cjs");
  const sentinel = join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
  // The preload reaches workers and records prohibited I/O before rejecting it.
  await writeFile(preloadPath, inspectionTripwireSource());
  await verifyTripwire(preloadPath, fixtureRoot);

  const verifyNoIo = async (): Promise<void> => {
    try {
      await access(sentinel);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    throw new Error(`Static Inspection attempted process or network I/O; see ${sentinel}.`);
  };

  return {
    run: async ({ adapter, arguments_, diagnosticContext, resolutionContext }) => {
      const command = adapter.kind === "installed" ? adapter.executablePath : process.execPath;
      const commandArguments =
        adapter.kind === "installed"
          ? [...arguments_, "--context", resolutionContext]
          : [
              join(adapter.sourceCheckout, "src", "cli.ts"),
              ...arguments_,
              "--context",
              resolutionContext,
            ];
      try {
        const result = await execa(command, commandArguments, {
          cwd: resolutionContext,
          env: guardedEnvironment(preloadPath, sentinel),
        });
        await verifyNoIo();
        return { stdout: result.stdout };
      } catch (error) {
        throw new Error(
          `${diagnosticContext}; command ${JSON.stringify([command, ...commandArguments])} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
    verifyNoIo,
  };
}

async function verifyTripwire(preloadPath: string, fixtureRoot: string): Promise<void> {
  const controlSentinel = join(fixtureRoot, "INSPECTION_TRIPWIRE_CONTROL");
  // Prove the preload is active before trusting a missing inspection sentinel.
  let commandFailed = false;
  let commandError: unknown;
  try {
    await execa(process.execPath, ["-e", 'require("node:net").connect(9, "127.0.0.1")'], {
      env: guardedEnvironment(preloadPath, controlSentinel),
    });
  } catch (error) {
    commandFailed = true;
    commandError = error;
  }

  try {
    await access(controlSentinel);
  } catch (error) {
    throw new Error("Static Inspection tripwire control did not record a network attempt.", {
      cause: commandError ?? error,
    });
  }
  await rm(controlSentinel);
  if (!commandFailed) {
    throw new Error("Static Inspection tripwire control did not reject a network attempt.");
  }
}

function guardedEnvironment(
  preloadPath: string,
  sentinel: string,
): Readonly<Record<string, string>> {
  // Temp roots can canonicalize differently; executable origin is checked separately.
  return {
    NODE_OPTIONS: [
      nodePathOption("--require", preloadPath),
      "--permission",
      "--allow-fs-read=*",
      nodePathOption("--allow-fs-write", sentinel),
      "--allow-worker",
    ].join(" "),
    PATH: process.env["PATH"] ?? "",
    TYPEPEEK_IO_SENTINEL: sentinel,
    npm_config_offline: "true",
  };
}

function nodePathOption(option: string, path: string): string {
  return `${option}=${JSON.stringify(path)}`;
}

function inspectionTripwireSource(): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    'const { syncBuiltinESMExports } = require("node:module");',
    "const trip = () => {",
    '  writeFileSync(process.env.TYPEPEEK_IO_SENTINEL, "attempted");',
    '  throw new Error("Inspection attempted process or network activity");',
    "};",
    "for (const [moduleName, methods] of Object.entries({",
    '  "node:child_process": ["exec", "execFile", "fork", "spawn", "execSync", "execFileSync", "spawnSync"],',
    '  "node:dgram": ["createSocket"],',
    '  "node:dns": ["lookup", "resolve", "resolve4", "resolve6"],',
    '  "node:http": ["get", "request"],',
    '  "node:http2": ["connect"],',
    '  "node:https": ["get", "request"],',
    '  "node:net": ["connect", "createConnection"],',
    '  "node:tls": ["connect"],',
    "})) {",
    "  const module = require(moduleName);",
    "  for (const method of methods) module[method] = trip;",
    "}",
    'const dgram = require("node:dgram");',
    'for (const method of ["bind", "connect", "send"]) dgram.Socket.prototype[method] = trip;',
    'const net = require("node:net");',
    "net.Socket.prototype.connect = trip;",
    'const tls = require("node:tls");',
    "tls.TLSSocket.prototype.connect = trip;",
    'const dns = require("node:dns");',
    'for (const method of ["resolve", "resolve4", "resolve6"]) dns.Resolver.prototype[method] = trip;',
    'const dnsPromises = require("node:dns/promises");',
    'for (const method of ["lookup", "resolve", "resolve4", "resolve6"]) dnsPromises[method] = trip;',
    'for (const method of ["resolve", "resolve4", "resolve6"]) dnsPromises.Resolver.prototype[method] = trip;',
    "globalThis.fetch = trip;",
    "globalThis.WebSocket = class { constructor() { trip(); } };",
    "globalThis.EventSource = class { constructor() { trip(); } };",
    "syncBuiltinESMExports();",
    "",
  ].join("\n");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
