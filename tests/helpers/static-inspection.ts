import { realpathSync } from "node:fs";
import {
  access,
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { analysisProcessNodeArguments } from "#typepeek/inspection/execution/analysis-process";
import { runCommand } from "#typepeek/platform/process-command";

interface GuardedEnvironment {
  readonly [key: string]: string | undefined;
}

const PLUGIN_RUNTIME_SOURCE = "module.exports = true;\n";
const PACKAGE_MANIFEST_FILE = "package.json";

const compilerExecutableFor = (entrypoint: string): string => {
  const require = createRequire(
    createRequire(pathToFileURL(realpathSync.native(entrypoint))).resolve(
      "tsrs/package.json"
    )
  );

  const base = `@tsrs/${process.platform}-${process.arch}`;

  for (const candidate of process.platform === "linux"
    ? [`${base}-gnu`, `${base}-musl`]
    : [base]) {
    try {
      return nodePath.join(
        nodePath.dirname(require.resolve(`${candidate}/package.json`)),
        process.platform === "win32" ? "tsrs.exe" : "tsrs"
      );
    } catch {
      // Only the current platform's optional dependency is installed.
    }
  }

  throw new Error("The CLI's pinned native compiler is missing.");
};

const PROTECTED_TRIPWIRE_ENVIRONMENT_NAMES = [
  "NODE_OPTIONS",
  "TYPEPEEK_ALLOWED_ANALYSIS_PROCESS_ENTRY",
  "TYPEPEEK_ALLOWED_COMPILER_EXECUTABLE",
  "TYPEPEEK_DENY_WORKERS",
  "TYPEPEEK_EXECUTABLE_PATHS",
  "TYPEPEEK_EXECUTABLE_ROOTS",
  "TYPEPEEK_FORBIDDEN_READ_PATHS",
  "TYPEPEEK_IO_SENTINEL",
] as const;

export interface StaticInspection {
  readonly run: (options: {
    readonly adapter:
      | {
          readonly kind: "installed";
          readonly executablePath: string;
          readonly analysisProcessEntryPath: string;
        }
      | {
          readonly kind: "source-checkout";
          readonly sourceCheckout: string;
        };
    readonly cliArguments: readonly string[];
    readonly diagnosticContext: string;
    readonly resolutionContext: string;
  }) => Promise<{
    readonly stdout: string;
  }>;
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

const inspectionTripwireSource = function inspectionTripwireSource(): string {
  const [heapArgument, stackArgument] =
    analysisProcessNodeArguments("<entrypoint>");

  return [
    'const fs = require("node:fs");',
    'const fsPromises = require("node:fs/promises");',
    'const Module = require("node:module");',
    'const path = require("node:path");',
    'const { fileURLToPath } = require("node:url");',
    'const workerThreads = require("node:worker_threads");',
    'const childProcess = require("node:child_process");',
    "const originalWriteFileSync = fs.writeFileSync.bind(fs);",
    "const ioSentinel = process.env.TYPEPEEK_IO_SENTINEL;",
    `const protectedWorkerEnvironment = Object.freeze(Object.fromEntries(${JSON.stringify(PROTECTED_TRIPWIRE_ENVIRONMENT_NAMES)}.map((name) => [name, process.env[name]])));`,
    "const executablePaths = forbiddenPathSet(process.env.TYPEPEEK_EXECUTABLE_PATHS);",
    "const executableRoots = [...forbiddenPathSet(process.env.TYPEPEEK_EXECUTABLE_ROOTS)];",
    "const forbiddenReads = forbiddenPathSet(process.env.TYPEPEEK_FORBIDDEN_READ_PATHS);",
    "const allowedAnalysisProcessEntries = forbiddenPathSet(process.env.TYPEPEEK_ALLOWED_ANALYSIS_PROCESS_ENTRY ? JSON.stringify([process.env.TYPEPEEK_ALLOWED_ANALYSIS_PROCESS_ENTRY]) : '[]');",
    "const allowedCompilerExecutables = forbiddenPathSet(process.env.TYPEPEEK_ALLOWED_COMPILER_EXECUTABLE ? JSON.stringify([process.env.TYPEPEEK_ALLOWED_COMPILER_EXECUTABLE]) : '[]');",
    'const denyWorkers = process.env.TYPEPEEK_DENY_WORKERS === "true";',
    "function forbiddenPathSet(serialized) {",
    "  return new Set(JSON.parse(serialized || '[]').flatMap(normalizePaths));",
    "}",
    "function normalizePaths(value) {",
    "  try {",
    // Windows realpath opens a path, consuming a named pipe's one client connection.
    "    if (process.platform === 'win32' && typeof value === 'string' && value.startsWith(String.raw`\\\\.\\pipe\\tsgo-sync-`)) return [value];",
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
    `  throw new Error(\`Inspection attempted prohibited \${activity}\`);`,
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
    '    if (denyWorkers) trip("worker");',
    '    if (options.eval !== true && isForbiddenWorkerEntry(filename)) trip("worker entry module load");',
    "    const requestedEnvironment = options.env === workerThreads.SHARE_ENV ? process.env : (options.env ?? process.env);",
    "    const env = { ...requestedEnvironment };",
    "    Object.assign(env, protectedWorkerEnvironment);",
    "    super(filename, { ...options, env });",
    "  }",
    "};",
    "function isAllowedAnalysisSpawn(command, args) {",
    "  if (!Array.isArray(args) || !isForbiddenPath(new Set(normalizePaths(process.execPath)), command)) return false;",
    `  if (args.length !== 3 || args[0] !== ${JSON.stringify(heapArgument)} || args[1] !== ${JSON.stringify(stackArgument)}) return false;`,
    "  return isForbiddenPath(allowedAnalysisProcessEntries, args[2]);",
    "}",
    "const originalSpawn = childProcess.spawn;",
    "function isAllowedCompilerSpawn(command, args) {",
    "  if (!isForbiddenPath(allowedAnalysisProcessEntries, process.argv[1]) || !isForbiddenPath(allowedCompilerExecutables, command)) return false;",
    "  if (!Array.isArray(args) || args.length !== 6) return false;",
    "  if (args[0] !== '--api' || args[1] !== '--async' || args[2] !== '--cwd' || args[3] !== process.cwd() || !/^--useCaseSensitiveFileNames=(true|false)$/.test(args[4])) return false;",
    "  return args[5].startsWith('--callbacks=') && args[5].slice('--callbacks='.length).split(',').sort().join(',') === 'directoryExists,fileExists,getAccessibleEntries,readFile,realpath,removeFile,stat,writeFile';",
    "}",
    "childProcess.spawn = function guardedSpawn(command, args, options) {",
    '  if (!isAllowedAnalysisSpawn(command, args) && !isAllowedCompilerSpawn(command, args)) trip("process activity");',
    "  return Reflect.apply(originalSpawn, this, [command, args, options]);",
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
    '  "node:child_process": ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"],',
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
};

const expandStaticInspectionPolicy = function expandStaticInspectionPolicy(
  policy: StaticInspectionPolicy
): TripwirePolicy {
  return {
    executablePaths: policy.executableArtifactPaths,
    forbiddenReadPaths: policy.executableArtifactPaths,
    ...(policy.moduleOnlyRoots !== undefined && {
      executableRoots: policy.moduleOnlyRoots,
    }),
  };
};

const nodePathOption = function nodePathOption(
  option: string,
  path: string
): string {
  return `${option}=${JSON.stringify(path)}`;
};

export const staticInspectionNodeOptions = (
  preloadPath: string,
  sentinel: string
): readonly string[] => [
  nodePathOption("--require", preloadPath),
  "--permission",
  "--allow-fs-read=*",
  nodePathOption("--allow-fs-write", sentinel),
  "--allow-child-process",
  "--allow-worker",
];

const guardedEnvironment = function guardedEnvironment(
  preloadPath: string,
  sentinel: string,
  policy: TripwirePolicy,
  processPolicy: {
    readonly allowedAnalysisProcessEntry?: string;
    readonly allowedCompilerExecutable?: string;
    readonly denyWorkers?: boolean;
  } = {}
): GuardedEnvironment {
  // Temp roots can canonicalize differently; executable origin is checked separately.
  return {
    NODE_OPTIONS: staticInspectionNodeOptions(preloadPath, sentinel).join(" "),
    PATH: process.env["PATH"] ?? "",
    TYPEPEEK_ALLOWED_ANALYSIS_PROCESS_ENTRY:
      processPolicy.allowedAnalysisProcessEntry ?? "",
    TYPEPEEK_ALLOWED_COMPILER_EXECUTABLE:
      processPolicy.allowedCompilerExecutable ?? "",
    TYPEPEEK_DENY_WORKERS:
      processPolicy.denyWorkers === true ? "true" : "false",
    TYPEPEEK_EXECUTABLE_PATHS: JSON.stringify(policy.executablePaths ?? []),
    TYPEPEEK_EXECUTABLE_ROOTS: JSON.stringify(policy.executableRoots ?? []),
    TYPEPEEK_FORBIDDEN_READ_PATHS: JSON.stringify(
      policy.forbiddenReadPaths ?? []
    ),
    TYPEPEEK_IO_SENTINEL: sentinel,
    npm_config_offline: "true",
  };
};

const verifyRejectedAttempt = async function verifyRejectedAttempt(options: {
  readonly description: string;
  readonly fixtureRoot: string;
  readonly policy: TripwirePolicy;
  readonly preloadPath: string;
  readonly source: string;
}): Promise<void> {
  const controlSentinel = nodePath.join(
    options.fixtureRoot,
    `INSPECTION_TRIPWIRE_CONTROL_${options.description.replaceAll(" ", "_")}`
  );

  let commandFailed = false;

  try {
    await runCommand(process.execPath, ["-e", options.source], {
      env: guardedEnvironment(
        options.preloadPath,
        controlSentinel,
        options.policy
      ),
    });
  } catch {
    commandFailed = true;
  }

  try {
    await access(controlSentinel);
  } catch (error) {
    throw new Error(
      `Static Inspection tripwire control did not record a ${options.description} attempt.`,
      { cause: error }
    );
  }

  await rm(controlSentinel);

  if (!commandFailed) {
    throw new Error(
      `Static Inspection tripwire control did not reject a ${options.description} attempt.`
    );
  }
};

const isMissingFileError = function isMissingFileError(
  cause: unknown
): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
};

const ignoreMissingFile = function ignoreMissingFile(cause: unknown): void {
  if (!isMissingFileError(cause)) {
    throw cause;
  }
};

const verifyTripwire = async function verifyTripwire(
  preloadPath: string,
  fixtureRoot: string
): Promise<void> {
  const controlModule = nodePath.join(
    fixtureRoot,
    "inspection-tripwire-control.cjs"
  );

  const controlEsmModule = nodePath.join(
    fixtureRoot,
    "inspection-tripwire-control.mjs"
  );

  const canonicalControlRoot = nodePath.join(
    fixtureRoot,
    "inspection-tripwire-real-root"
  );

  const symlinkControlRoot = nodePath.join(
    fixtureRoot,
    "inspection-tripwire-link-root"
  );

  const canonicalControlModule = nodePath.join(
    canonicalControlRoot,
    "control.cjs"
  );

  const logicalPackageContext = nodePath.join(
    fixtureRoot,
    "inspection-tripwire-logical-context"
  );

  const physicalPackageRoot = nodePath.join(
    fixtureRoot,
    "inspection-tripwire-physical-package"
  );

  const logicalPackageLink = nodePath.join(
    logicalPackageContext,
    "node_modules",
    "control-package"
  );

  const logicalWorkerLink = nodePath.join(
    logicalPackageContext,
    "linked-worker"
  );

  try {
    await Promise.all([
      mkdir(canonicalControlRoot),
      mkdir(nodePath.join(logicalPackageContext, "node_modules"), {
        recursive: true,
      }),
      mkdir(physicalPackageRoot),
    ]);
    await Promise.all([
      writeFile(controlModule, PLUGIN_RUNTIME_SOURCE),
      writeFile(controlEsmModule, "export default true;\n"),
      writeFile(canonicalControlModule, PLUGIN_RUNTIME_SOURCE),
      writeFile(
        nodePath.join(logicalPackageContext, PACKAGE_MANIFEST_FILE),
        '{"private":true}'
      ),
      writeFile(
        nodePath.join(physicalPackageRoot, PACKAGE_MANIFEST_FILE),
        '{"name":"control-package","main":"./index.cjs"}'
      ),
      writeFile(
        nodePath.join(physicalPackageRoot, "index.cjs"),
        PLUGIN_RUNTIME_SOURCE
      ),
      writeFile(
        nodePath.join(physicalPackageRoot, "worker.mjs"),
        "export default true;\n"
      ),
    ]);
    await Promise.all([
      symlink(
        canonicalControlRoot,
        symlinkControlRoot,
        process.platform === "win32" ? "junction" : "dir"
      ),
      symlink(
        physicalPackageRoot,
        logicalPackageLink,
        process.platform === "win32" ? "junction" : "dir"
      ),
      symlink(
        physicalPackageRoot,
        logicalWorkerLink,
        process.platform === "win32" ? "junction" : "dir"
      ),
    ]);

    const publicArtifactPolicy = expandStaticInspectionPolicy({
      executableArtifactPaths: [controlModule],
    });

    const publicRootPolicy = expandStaticInspectionPolicy({
      executableArtifactPaths: [],
      moduleOnlyRoots: [fixtureRoot],
    });

    const generatedText1 = JSON.stringify(
      `require(${JSON.stringify(controlModule)})`
    );

    const generatedText2 = JSON.stringify(
      `import(${JSON.stringify(pathToFileURL(controlEsmModule).href)})`
    );

    const generatedText3 = JSON.stringify(
      `require("node:fs").readFileSync(${JSON.stringify(controlModule)})`
    );

    const generatedText4 = JSON.stringify(
      `require("node:fs").openAsBlob(${JSON.stringify(controlModule)}).then((blob) => blob.text())`
    );

    const generatedText5 = JSON.stringify(
      `require("node:fs").readFileSync(${JSON.stringify(controlModule)})`
    );

    const generatedText6 = JSON.stringify(
      `require("node:fs").readFileSync(${JSON.stringify(controlModule)})`
    );

    const generatedText7 = JSON.stringify(
      `require(${JSON.stringify(canonicalControlModule)})`
    );

    const generatedText8 = JSON.stringify(
      `require("node:module").createRequire(${JSON.stringify(nodePath.join(logicalPackageContext, PACKAGE_MANIFEST_FILE))})("control-package")`
    );

    const generatedText9 = JSON.stringify(
      `require("node:fs").readFileSync(${JSON.stringify(canonicalControlModule)})`
    );

    const results = await Promise.allSettled([
      verifyRejectedAttempt({
        description: "worker network",
        fixtureRoot,
        policy: {},
        preloadPath,
        source:
          'new (require("node:worker_threads").Worker)(\'require("node:net").connect(9, "127.0.0.1")\', { eval: true });',
      }),
      verifyRejectedAttempt({
        description: "worker CommonJS module load",
        fixtureRoot,
        policy: publicArtifactPolicy,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText1}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "worker ESM module load",
        fixtureRoot,
        policy: publicRootPolicy,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText2}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "worker file read",
        fixtureRoot,
        policy: publicArtifactPolicy,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText3}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "worker blob file read",
        fixtureRoot,
        policy: publicArtifactPolicy,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText4}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "worker isolated environment file read",
        fixtureRoot,
        policy: publicArtifactPolicy,
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText5}, { env: {}, eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "worker mutated environment file read",
        fixtureRoot,
        policy: publicArtifactPolicy,
        preloadPath,
        source: `for (const name of ${JSON.stringify(PROTECTED_TRIPWIRE_ENVIRONMENT_NAMES)}) process.env[name] = ""; new (require("node:worker_threads").Worker)(${generatedText6}, { env: {}, eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "worker process",
        fixtureRoot,
        policy: {},
        preloadPath,
        source:
          'new (require("node:worker_threads").Worker)(\'require("node:child_process").execFileSync(process.execPath, ["--version"])\', { eval: true });',
      }),
      verifyRejectedAttempt({
        description: "canonical worker module load",
        fixtureRoot,
        policy: expandStaticInspectionPolicy({
          executableArtifactPaths: [],
          moduleOnlyRoots: [symlinkControlRoot],
        }),
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText7}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "symlinked descendant module load",
        fixtureRoot,
        policy: expandStaticInspectionPolicy({
          executableArtifactPaths: [],
          moduleOnlyRoots: [logicalPackageContext],
        }),
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText8}, { eval: true });`,
      }),
      verifyRejectedAttempt({
        description: "symlinked worker entry module load",
        fixtureRoot,
        policy: expandStaticInspectionPolicy({
          executableArtifactPaths: [],
          moduleOnlyRoots: [logicalPackageContext],
        }),
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${JSON.stringify(nodePath.join(logicalWorkerLink, "worker.mjs"))});`,
      }),
      verifyRejectedAttempt({
        description: "canonical worker file read",
        fixtureRoot,
        policy: {
          forbiddenReadPaths: [
            nodePath.join(
              symlinkControlRoot,
              nodePath.basename(canonicalControlModule)
            ),
          ],
        },
        preloadPath,
        source: `new (require("node:worker_threads").Worker)(${generatedText9}, { eval: true });`,
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
      rm(canonicalControlRoot, { force: true, recursive: true }),
      rm(logicalPackageContext, { force: true, recursive: true }),
      rm(physicalPackageRoot, { force: true, recursive: true }),
      unlink(symlinkControlRoot).catch(ignoreMissingFile),
    ]);
  }
};

const DEFAULT_STATIC_INSPECTION_POLICY: StaticInspectionPolicy = {
  executableArtifactPaths: [],
};

export const materializeStaticInspection =
  async function materializeStaticInspection(
    fixtureRoot: string,
    policy: StaticInspectionPolicy = DEFAULT_STATIC_INSPECTION_POLICY
  ): Promise<StaticInspection> {
    const preloadPath = nodePath.join(fixtureRoot, "inspection-tripwire.cjs");
    const sentinel = nodePath.join(fixtureRoot, "INSPECTION_IO_ATTEMPTED");
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

      throw new Error(
        `Static Inspection attempted prohibited activity; see ${sentinel}.`
      );
    };

    return {
      run: async ({
        adapter,
        cliArguments,
        diagnosticContext,
        resolutionContext,
      }) => {
        const command =
          adapter.kind === "installed"
            ? adapter.executablePath
            : process.execPath;

        const analysisProcessEntryPath =
          adapter.kind === "installed"
            ? adapter.analysisProcessEntryPath
            : nodePath.join(
                adapter.sourceCheckout,
                "src",
                "inspection",
                "analysis-process-entry.ts"
              );

        const commandArguments =
          adapter.kind === "installed"
            ? [...cliArguments, "--workspace", resolutionContext]
            : [
                nodePath.join(adapter.sourceCheckout, "src", "cli.ts"),
                ...cliArguments,
                "--workspace",
                resolutionContext,
              ];

        const windowsCommandShim =
          process.platform === "win32" && /\.cmd$/iu.test(command);

        try {
          const result = await runCommand(
            windowsCommandShim ? `"${command}"` : command,
            windowsCommandShim
              ? commandArguments.map((argument) => `"${argument}"`)
              : commandArguments,
            {
              cwd: resolutionContext,
              env: guardedEnvironment(preloadPath, sentinel, tripwirePolicy, {
                allowedAnalysisProcessEntry: analysisProcessEntryPath,
                allowedCompilerExecutable: compilerExecutableFor(
                  analysisProcessEntryPath
                ),
                denyWorkers: true,
              }),
              // Windows package-manager shims require Effect's shell option.
              shell: windowsCommandShim,
            }
          );

          await verifyNoIo();

          return { stdout: result.stdout };
        } catch (error) {
          throw new Error(
            `${diagnosticContext}; command ${JSON.stringify([command, ...commandArguments])} failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      },
      verifyNoIo,
    };
  };
