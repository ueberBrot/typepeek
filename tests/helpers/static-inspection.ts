import { execa } from "execa";
import { access, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const PROTECTED_TRIPWIRE_ENVIRONMENT_NAMES = [
  "NODE_OPTIONS",
  "TYPEPEEK_EXECUTABLE_PATHS",
  "TYPEPEEK_EXECUTABLE_ROOTS",
  "TYPEPEEK_FORBIDDEN_READ_PATHS",
  "TYPEPEEK_IO_SENTINEL",
] as const;

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

export interface StaticInspectionPolicy {
  readonly executableArtifactPaths: readonly string[];
  readonly moduleOnlyRoots?: readonly string[];
}

interface TripwirePolicy {
  readonly executablePaths?: readonly string[];
  readonly executableRoots?: readonly string[];
  readonly forbiddenReadPaths?: readonly string[];
}

export async function materializeStaticInspection(
  fixtureRoot: string,
  policy: StaticInspectionPolicy = { executableArtifactPaths: [] },
): Promise<StaticInspection> {
  const preloadPath = join(fixtureRoot, "inspection-tripwire.cjs");
  const sentinel = join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
  // The preload reaches workers and records prohibited I/O before rejecting it.
  await writeFile(preloadPath, inspectionTripwireSource());
  await verifyTripwire(preloadPath, fixtureRoot);
  const tripwirePolicy = expandStaticInspectionPolicy(policy);

  const verifyNoIo = async (): Promise<void> => {
    try {
      await access(sentinel);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    throw new Error(`Static Inspection attempted prohibited activity; see ${sentinel}.`);
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
          env: guardedEnvironment(preloadPath, sentinel, tripwirePolicy),
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
  const controlModule = join(fixtureRoot, "inspection-tripwire-control.cjs");
  const controlEsmModule = join(fixtureRoot, "inspection-tripwire-control.mjs");
  const canonicalControlRoot = join(fixtureRoot, "inspection-tripwire-real-root");
  const symlinkControlRoot = join(fixtureRoot, "inspection-tripwire-link-root");
  const canonicalControlModule = join(canonicalControlRoot, "control.cjs");
  const logicalPackageContext = join(fixtureRoot, "inspection-tripwire-logical-context");
  const physicalPackageRoot = join(fixtureRoot, "inspection-tripwire-physical-package");
  const logicalPackageLink = join(logicalPackageContext, "node_modules", "control-package");
  const logicalWorkerLink = join(logicalPackageContext, "linked-worker");
  try {
    await Promise.all([
      mkdir(canonicalControlRoot),
      mkdir(join(logicalPackageContext, "node_modules"), { recursive: true }),
      mkdir(physicalPackageRoot),
    ]);
    await Promise.all([
      writeFile(controlModule, "module.exports = true;\n"),
      writeFile(controlEsmModule, "export default true;\n"),
      writeFile(canonicalControlModule, "module.exports = true;\n"),
      writeFile(join(logicalPackageContext, "package.json"), '{"private":true}'),
      writeFile(
        join(physicalPackageRoot, "package.json"),
        '{"name":"control-package","main":"./index.cjs"}',
      ),
      writeFile(join(physicalPackageRoot, "index.cjs"), "module.exports = true;\n"),
      writeFile(join(physicalPackageRoot, "worker.mjs"), "export default true;\n"),
    ]);
    await Promise.all([
      symlink(
        canonicalControlRoot,
        symlinkControlRoot,
        process.platform === "win32" ? "junction" : "dir",
      ),
      symlink(
        physicalPackageRoot,
        logicalPackageLink,
        process.platform === "win32" ? "junction" : "dir",
      ),
      symlink(
        physicalPackageRoot,
        logicalWorkerLink,
        process.platform === "win32" ? "junction" : "dir",
      ),
    ]);
    const publicArtifactPolicy = expandStaticInspectionPolicy({
      executableArtifactPaths: [controlModule],
    });
    const publicRootPolicy = expandStaticInspectionPolicy({
      executableArtifactPaths: [],
      moduleOnlyRoots: [fixtureRoot],
    });
    const results = await Promise.allSettled([
      verifyRejectedAttempt({
        policy: {},
        description: "worker network",
        fixtureRoot,
        preloadPath,
        source:
          'new (require("node:worker_threads").Worker)(\'require("node:net").connect(9, "127.0.0.1")\', { eval: true });',
      }),
      verifyRejectedAttempt({
        policy: publicArtifactPolicy,
        description: "worker CommonJS module load",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require(${JSON.stringify(controlModule)})`)}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: publicRootPolicy,
        description: "worker ESM module load",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`import(${JSON.stringify(pathToFileURL(controlEsmModule).href)})`)}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: publicArtifactPolicy,
        description: "worker file read",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require("node:fs").readFileSync(${JSON.stringify(controlModule)})`)}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: publicArtifactPolicy,
        description: "worker blob file read",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require("node:fs").openAsBlob(${JSON.stringify(controlModule)}).then((blob) => blob.text())`)}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: publicArtifactPolicy,
        description: "worker isolated environment file read",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require("node:fs").readFileSync(${JSON.stringify(controlModule)})`)}, { env: {}, eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: publicArtifactPolicy,
        description: "worker mutated environment file read",
        fixtureRoot,
        preloadPath,
        source: `for (const name of ${JSON.stringify(PROTECTED_TRIPWIRE_ENVIRONMENT_NAMES)}) process.env[name] = ""; new (require("node:worker_threads").Worker)(${JSON.stringify(`require("node:fs").readFileSync(${JSON.stringify(controlModule)})`)}, { env: {}, eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: {},
        description: "worker process",
        fixtureRoot,
        preloadPath,
        source:
          'new (require("node:worker_threads").Worker)(\'require("node:child_process").execFileSync(process.execPath, ["--version"])\', { eval: true });',
      }),
      verifyRejectedAttempt({
        policy: expandStaticInspectionPolicy({
          executableArtifactPaths: [],
          moduleOnlyRoots: [symlinkControlRoot],
        }),
        description: "canonical worker module load",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require(${JSON.stringify(canonicalControlModule)})`)}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: expandStaticInspectionPolicy({
          executableArtifactPaths: [],
          moduleOnlyRoots: [logicalPackageContext],
        }),
        description: "symlinked descendant module load",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require("node:module").createRequire(${JSON.stringify(join(logicalPackageContext, "package.json"))})("control-package")`)}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        policy: expandStaticInspectionPolicy({
          executableArtifactPaths: [],
          moduleOnlyRoots: [logicalPackageContext],
        }),
        description: "symlinked worker entry module load",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(join(logicalWorkerLink, "worker.mjs"))});`,
      }),
      verifyRejectedAttempt({
        policy: {
          forbiddenReadPaths: [join(symlinkControlRoot, basename(canonicalControlModule))],
        },
        description: "canonical worker file read",
        fixtureRoot,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(`require("node:fs").readFileSync(${JSON.stringify(canonicalControlModule)})`)}, { eval: true });`,
      }),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  } finally {
    await Promise.all([
      rm(controlModule, { force: true }),
      rm(controlEsmModule, { force: true }),
      rm(canonicalControlRoot, { recursive: true, force: true }),
      rm(logicalPackageContext, { recursive: true, force: true }),
      rm(physicalPackageRoot, { recursive: true, force: true }),
      unlink(symlinkControlRoot).catch(ignoreMissingFile),
    ]);
  }
}

async function verifyRejectedAttempt(options: {
  readonly description: string;
  readonly fixtureRoot: string;
  readonly policy: TripwirePolicy;
  readonly preloadPath: string;
  readonly source: string;
}): Promise<void> {
  const controlSentinel = join(
    options.fixtureRoot,
    `INSPECTION_TRIPWIRE_CONTROL_${options.description.replaceAll(" ", "_")}`,
  );
  let commandFailed = false;
  let commandError: unknown;
  try {
    await execa(process.execPath, ["-e", options.source], {
      env: guardedEnvironment(options.preloadPath, controlSentinel, options.policy),
    });
  } catch (error) {
    commandFailed = true;
    commandError = error;
  }

  try {
    await access(controlSentinel);
  } catch (error) {
    throw new Error(
      `Static Inspection tripwire control did not record a ${options.description} attempt.`,
      { cause: commandError ?? error },
    );
  }
  await rm(controlSentinel);
  if (!commandFailed) {
    throw new Error(
      `Static Inspection tripwire control did not reject a ${options.description} attempt.`,
    );
  }
}

function guardedEnvironment(
  preloadPath: string,
  sentinel: string,
  policy: TripwirePolicy,
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
    TYPEPEEK_EXECUTABLE_PATHS: JSON.stringify(policy.executablePaths ?? []),
    TYPEPEEK_EXECUTABLE_ROOTS: JSON.stringify(policy.executableRoots ?? []),
    TYPEPEEK_FORBIDDEN_READ_PATHS: JSON.stringify(policy.forbiddenReadPaths ?? []),
    TYPEPEEK_IO_SENTINEL: sentinel,
    npm_config_offline: "true",
  };
}

function nodePathOption(option: string, path: string): string {
  return `${option}=${JSON.stringify(path)}`;
}

function expandStaticInspectionPolicy(policy: StaticInspectionPolicy): TripwirePolicy {
  return {
    executablePaths: policy.executableArtifactPaths,
    forbiddenReadPaths: policy.executableArtifactPaths,
    ...(policy.moduleOnlyRoots === undefined ? {} : { executableRoots: policy.moduleOnlyRoots }),
  };
}

function inspectionTripwireSource(): string {
  return [
    'const fs = require("node:fs");',
    'const fsPromises = require("node:fs/promises");',
    'const Module = require("node:module");',
    'const path = require("node:path");',
    'const { fileURLToPath } = require("node:url");',
    'const workerThreads = require("node:worker_threads");',
    "const originalWriteFileSync = fs.writeFileSync.bind(fs);",
    "const ioSentinel = process.env.TYPEPEEK_IO_SENTINEL;",
    `const protectedWorkerEnvironment = Object.freeze(Object.fromEntries(${JSON.stringify(PROTECTED_TRIPWIRE_ENVIRONMENT_NAMES)}.map((name) => [name, process.env[name]])));`,
    "const executablePaths = forbiddenPathSet(process.env.TYPEPEEK_EXECUTABLE_PATHS);",
    "const executableRoots = [...forbiddenPathSet(process.env.TYPEPEEK_EXECUTABLE_ROOTS)];",
    "const forbiddenReads = forbiddenPathSet(process.env.TYPEPEEK_FORBIDDEN_READ_PATHS);",
    "function forbiddenPathSet(serialized) {",
    "  return new Set(JSON.parse(serialized || '[]').flatMap(normalizePaths));",
    "}",
    "function normalizePaths(value) {",
    "  try {",
    '    const lexical = value instanceof URL || (typeof value === "string" && value.startsWith("file:"))',
    "      ? path.resolve(fileURLToPath(value))",
    '      : typeof value === "string" || Buffer.isBuffer(value) ? path.resolve(String(value)) : undefined;',
    "    if (lexical === undefined) return [];",
    "    try {",
    "      const canonical = fs.realpathSync.native(lexical);",
    "      return canonical === lexical ? [lexical] : [lexical, canonical];",
    "    } catch {",
    "      return [lexical];",
    "    }",
    "  } catch {",
    "    return [];",
    "  }",
    "}",
    "function isForbiddenPath(paths, value) {",
    "  return normalizePaths(value).some((candidate) => paths.has(candidate));",
    "}",
    "function normalizeModulePaths(value) {",
    '  if (typeof value === "string" && !value.startsWith("file:") && !path.isAbsolute(value)) return [];',
    "  return normalizePaths(value);",
    "}",
    "function isForbiddenModule(value) {",
    "  return normalizeModulePaths(value).some((candidate) => executablePaths.has(candidate) || executableRoots.some((root) => candidate === root || candidate.startsWith(root + path.sep)));",
    "}",
    "function isForbiddenWorkerEntry(value) {",
    "  return normalizePaths(value).some((candidate) => executablePaths.has(candidate) || executableRoots.some((root) => candidate === root || candidate.startsWith(root + path.sep)));",
    "}",
    "function hasExecutableParent(parent) {",
    "  return parent !== undefined && isForbiddenModule(parent.filename);",
    "}",
    "const trip = (activity = 'process or network activity') => {",
    "  originalWriteFileSync(ioSentinel, String(activity));",
    "  throw new Error(`Inspection attempted prohibited ${activity}`);",
    "};",
    "for (const [target, method] of [",
    '  [fs, "readFile"], [fs, "readFileSync"], [fs, "open"], [fs, "openSync"], [fs, "openAsBlob"], [fs, "createReadStream"],',
    '  [fsPromises, "readFile"], [fsPromises, "open"],',
    "]) {",
    "  const original = target[method];",
    "  target[method] = function guardedRead(file, ...rest) {",
    '    if (isForbiddenPath(forbiddenReads, file)) trip("file read");',
    "    return Reflect.apply(original, this, [file, ...rest]);",
    "  };",
    "}",
    "const OriginalWorker = workerThreads.Worker;",
    "workerThreads.Worker = class StaticInspectionWorker extends OriginalWorker {",
    "  constructor(filename, options = {}) {",
    '    if (options.eval !== true && isForbiddenWorkerEntry(filename)) trip("worker entry module load");',
    "    const requestedEnvironment = options.env === workerThreads.SHARE_ENV ? process.env : (options.env ?? process.env);",
    "    const env = { ...requestedEnvironment };",
    "    Object.assign(env, protectedWorkerEnvironment);",
    "    super(filename, { ...options, env });",
    "  }",
    "};",
    "const originalModuleLoad = Module._load;",
    "Module._load = function guardedModuleLoad(request, parent, isMain) {",
    "  let resolved;",
    "  try { resolved = Module._resolveFilename(request, parent, isMain); } catch {}",
    '  if (!Module.isBuiltin(request) && (isForbiddenModule(request) || isForbiddenModule(resolved) || hasExecutableParent(parent))) trip("module load");',
    "  return Reflect.apply(originalModuleLoad, this, [request, parent, isMain]);",
    "};",
    "Module.registerHooks({",
    "  resolve(specifier, context, nextResolve) {",
    "    const resolution = nextResolve(specifier, context);",
    '    if (!Module.isBuiltin(specifier) && (isForbiddenModule(specifier) || isForbiddenModule(resolution.url) || isForbiddenModule(context.parentURL))) trip("module load");',
    "    return resolution;",
    "  },",
    "  load(url, context, nextLoad) {",
    '    if (isForbiddenModule(url)) trip("module load");',
    "    return nextLoad(url, context);",
    "  },",
    "});",
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
    "Module.syncBuiltinESMExports();",
    "",
  ].join("\n");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function ignoreMissingFile(error: unknown): void {
  if (!isMissingFileError(error)) {
    throw error;
  }
}
