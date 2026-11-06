import nodePath from "node:path";

import { layer as nodeChildProcessLayer } from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { layer as nodeFileSystemLayer } from "@effect/platform-node-shared/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node-shared/NodePath";
import { layer as nodeStdioLayer } from "@effect/platform-node-shared/NodeStdio";
import { layer as nodeTerminalLayer } from "@effect/platform-node-shared/NodeTerminal";
import { Effect, Exit, Layer, Scope } from "effect";
import { ChildProcess } from "effect/process";

export const nodeProcessLayer = Layer.provideMerge(
  nodeChildProcessLayer,
  Layer.mergeAll(nodeFileSystemLayer, nodePathLayer)
);

export const nodeCliLayer = Layer.mergeAll(
  nodeProcessLayer,
  nodeStdioLayer,
  nodeTerminalLayer
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
