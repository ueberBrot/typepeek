import nodePath from "node:path";

import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { CompilerSession } from "#typepeek/inspection/compiler/compiler-session";
import type { ResolutionFileSystem } from "#typepeek/inspection/compiler/compiler-session";
import { createCompilerSessionOwner } from "#typepeek/inspection/compiler/compiler-session-owner";

const fileSystemFor = (file: string, text: string): ResolutionFileSystem => ({
  directoryExists: (name) => name === nodePath.dirname(file),
  fileExists: (name) => name === file,
  getDirectories: () => [],
  readFile: (name) => (name === file ? text : undefined),
  realpath: (name) => name,
});

describe("compiler session authority", () => {
  it.each([false, true])(
    "keeps overlapping filesystem authority exclusive after rejection: %s",
    async (rejectFirst) => {
      await using session = new CompilerSession();
      const fileA = nodePath.resolve("authority-a.d.ts");
      const fileB = nodePath.resolve("authority-b.d.ts");
      const sourceA = "export declare const authorityA: string;";
      const sourceB = "export declare const authorityB: number;";
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const events: string[] = [];

      const first = session.withFileSystem(
        fileSystemFor(fileA, sourceA),
        async () => {
          events.push("A");
          entered.resolve(undefined);
          await release.promise;

          const program = await session.api.createProgram([fileA], {
            noLib: true,
          });

          const sourceFile = await program.getSourceFile(fileA);
          const text = sourceFile?.getText();

          if (rejectFirst) {
            throw new Error("first operation rejected");
          }

          return text;
        }
      );

      await entered.promise;

      const second = session.withFileSystem(
        fileSystemFor(fileB, sourceB),
        async () => {
          events.push("B");

          const program = await session.api.createProgram([fileB], {
            noLib: true,
          });

          const sourceFile = await program.getSourceFile(fileB);

          return sourceFile?.getText();
        }
      );

      try {
        expect(events).toStrictEqual(["A"]);
        release.resolve(undefined);

        const [firstResult] = await Promise.allSettled([first]);
        expect(firstResult).toMatchObject(
          rejectFirst
            ? {
                reason: { message: "first operation rejected" },
                status: "rejected",
              }
            : { status: "fulfilled", value: sourceA }
        );
        await expect(second).resolves.toBe(sourceB);
        expect(events).toStrictEqual(["A", "B"]);
      } finally {
        release.resolve(undefined);
        await Promise.allSettled([first, second]);
      }
    }
  );
});

describe("inspection compiler ownership", () => {
  it("closes only the compiler sessions retained by one inspection", async () => {
    const firstOwner = createCompilerSessionOwner();
    const secondOwner = createCompilerSessionOwner();
    const first = new CompilerSession(undefined, firstOwner);
    const second = new CompilerSession(undefined, secondOwner);

    try {
      await firstOwner.close();
      await expect(
        first.api.createSourceFile("closed.d.ts", "export {};")
      ).rejects.toThrow(/closed/iu);

      const lease = await second.api.createSourceFile(
        "live.d.ts",
        "export declare const live: number;"
      );

      expect(lease.sourceFile.getText()).toBe(
        "export declare const live: number;"
      );
      await lease[Symbol.asyncDispose]();
    } finally {
      await Promise.allSettled([firstOwner.close(), secondOwner.close()]);
    }
  });

  it("attempts every compiler close even when one resource rejects", async () => {
    const owner = createCompilerSessionOwner();
    const closed: string[] = [];
    owner.retain({
      close: async () => {
        closed.push("failed");
        await Promise.resolve(undefined);
        throw new Error("close failed");
      },
    });
    owner.retain({
      close: async () => {
        await Promise.resolve(undefined);
        closed.push("healthy");
      },
    });
    await expect(owner.close()).rejects.toBeInstanceOf(AggregateError);
    expect(closed.toSorted()).toStrictEqual(["failed", "healthy"]);
    await expect(owner.close()).rejects.toBeInstanceOf(AggregateError);
    expect(closed).toHaveLength(2);
  });

  it("shares pending cleanup and rejects compiler registration after shutdown starts", async () => {
    const owner = createCompilerSessionOwner();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let completed = false;
    owner.retain({
      close: async () => {
        entered.resolve(undefined);
        await release.promise;
      },
    });
    const firstClose = owner.close();
    await entered.promise;

    const secondClose = owner.close().then(() => (completed = true));

    try {
      await Promise.resolve(undefined);
      expect(completed).toBeFalsy();
      expect(() => new CompilerSession(undefined, owner)).toThrow(/closed/iu);
    } finally {
      release.resolve(undefined);
      await Promise.all([firstClose, secondClose]);
    }

    expect(completed).toBeTruthy();
    expect(() => new CompilerSession(undefined, owner)).toThrow(/closed/iu);
  });

  it("waits for active filesystem authority before closing an interrupted inspection", async () => {
    const owner = createCompilerSessionOwner();
    const session = new CompilerSession(undefined, owner);
    const entered = Promise.withResolvers<undefined>();
    const cleanupStarted = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const file = nodePath.resolve("interrupted-authority.d.ts");
    const source = "export declare const active: number;";

    const pending = session.withFileSystem(
      fileSystemFor(file, source),
      async () => {
        entered.resolve(undefined);
        await release.promise;

        const program = await session.api.createProgram([file], {
          noLib: true,
        });

        const sourceFile = await program.getSourceFile(file);

        return sourceFile?.getText();
      }
    );

    let closed = false;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* inspection() {
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* cleanup() {
              cleanupStarted.resolve(undefined);
              yield* owner.closeEffect;
              closed = true;
            })
          );
          yield* Effect.promise(async () => await pending);
        })
      )
    );

    await entered.promise;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber));

    try {
      await cleanupStarted.promise;
      expect(closed).toBeFalsy();
      release.resolve(undefined);
      await expect(pending).resolves.toBe(source);
      await interruption;
      expect(closed).toBeTruthy();
      await expect(
        session.api.createSourceFile(
          "closed-after-interruption.d.ts",
          "export {};"
        )
      ).rejects.toThrow(/closed/iu);
    } finally {
      release.resolve(undefined);
      await interruption;
      await owner.close();
    }
  });
});
