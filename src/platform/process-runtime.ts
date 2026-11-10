import { layer as bunChildProcessLayer } from "@effect/platform-bun/BunChildProcessSpawner";
import { layer as bunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { layer as bunPathLayer } from "@effect/platform-bun/BunPath";
import { layer as bunStdioLayer } from "@effect/platform-bun/BunStdio";
import { layer as bunTerminalLayer } from "@effect/platform-bun/BunTerminal";
import { Effect, Exit, Layer, Scope } from "effect";
import { ChildProcess } from "effect/process";

import { platformPath as nodePath } from "#typepeek/platform/platform-path";

export const processLayer = Layer.provideMerge(
  bunChildProcessLayer,
  Layer.mergeAll(bunFileSystemLayer, bunPathLayer)
);

export const cliLayer = Layer.mergeAll(
  processLayer,
  bunStdioLayer,
  bunTerminalLayer
);

/** Use native scopes for process groups; protect Windows tree termination from PATH lookup. */
export const spawnProcess = Effect.fnUntraced(function* spawnProcess(
  command: ChildProcess.Command
) {
  const handle = yield* command;

  if (process.platform === "win32") {
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* terminateWindowsTree() {
        if (yield* handle.isRunning) {
          const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];

          if (systemRoot === undefined) {
            return yield* Effect.die(
              new Error(
                "Windows must provide SystemRoot or WINDIR for process cleanup."
              )
            );
          }

          yield* Effect.scoped(
            Effect.gen(function* terminateTree() {
              const killer = yield* ChildProcess.make(
                nodePath.join(systemRoot, "System32", "taskkill.exe"),
                ["/PID", String(handle.pid), "/T", "/F"],
                {
                  forceKillAfter: 1000,
                  stderr: "ignore",
                  stdout: "ignore",
                }
              );

              const exitCode = yield* killer.exitCode;

              if (exitCode === 0) {
                yield* handle.exitCode.pipe(Effect.ignore);
              }
            })
          ).pipe(Effect.ignore);
        }

        return yield* Effect.void;
      }).pipe(Effect.orDie)
    );
  }

  return handle;
});

/** Reap the process group when the leader exits, before waiting for inherited output pipes. */
export const scopedProcess = Effect.fnUntraced(function* scopedProcess(
  command: ChildProcess.Command
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));

  const handle = yield* spawnProcess(command).pipe(
    Effect.provideService(Scope.Scope, scope)
  );

  return {
    ...handle,
    exitCode: Effect.exit(handle.exitCode).pipe(
      Effect.tap(() => Scope.close(scope, Exit.void))
    ),
  };
});
