import { defineAgent } from "@tanstack/ai";
import { codexText } from "@tanstack/ai-codex";
import {
  createHarnessHost,
  defineHarness,
  logIdOf,
} from "@tanstack/ai-harness";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxDefinition, SandboxHandle } from "@tanstack/ai-sandbox";
import { withSandbox } from "@tanstack/ai-sandbox";
import { otelMiddleware } from "@tanstack/ai/middlewares/otel";
import { Schema } from "effect";

import type { createHarnessArtifacts } from "./artifacts.ts";
import { createHarnessTraces } from "./traces.ts";

export interface HarnessExecution {
  readonly artifacts: ReturnType<typeof createHarnessArtifacts>;
  readonly sandbox: SandboxDefinition;
  readonly runId: string;
}

const captureCommand = async (
  handle: SandboxHandle,
  command: string,
  artifacts: ReturnType<typeof createHarnessArtifacts>,
  signal?: AbortSignal
) => {
  const child = await handle.process.spawn(command, {
    signal: signal ?? new AbortController().signal,
  });

  const copy = async (side: "stdout" | "stderr") => {
    for await (const text of child[side]) {
      artifacts.record("command.jsonl", { side, text });
      process[side].write(text);
    }
  };

  const [exitCode] = await Promise.all([
    child.wait(),
    copy("stdout"),
    copy("stderr"),
  ]);

  artifacts.record("command.jsonl", { exitCode });

  return { exitCode };
};

export const createTestHarness = (execution: HarnessExecution) => {
  const { artifacts } = execution;
  const traces = createHarnessTraces(artifacts);
  const persistence = memoryPersistence();
  const logId = logIdOf({ logId: execution.runId });
  let lastSequence = 0;
  let pending = Promise.resolve();
  let persistenceFailure: unknown;

  const exportLog = async (previous: Promise<void>): Promise<void> => {
    try {
      await previous;

      for (const entry of await persistence.stores.log.read({
        after: lastSequence,
        logId,
      })) {
        artifacts.record("harness.log.jsonl", { ...entry });
        lastSequence = entry.seq;
      }
    } catch (error) {
      persistenceFailure ??= error;
    }
  };

  const stopLogging = persistence.stores.log.subscribe({
    listener: () => {
      pending = exportLog(pending);
    },
    logId,
  });

  const command = defineAgent({
    description: "Run a test or benchmark command inside the sandbox.",
    inputSchema: Schema.toStandardSchemaV1(
      Schema.Struct({ command: Schema.String })
    ),
    name: "command",
    run: async (context) => {
      const ensureContext = {
        runId: execution.runId,
        signal: context.abortSignal ?? new AbortController().signal,
        threadId: execution.runId,
      };

      const handle = await execution.sandbox.ensure(ensureContext);

      artifacts.record("sandbox.jsonl", {
        capabilities: handle.capabilities,
        id: handle.id,
      });

      return await captureCommand(
        handle,
        context.input.command,
        artifacts,
        context.abortSignal
      );
    },
  });

  const codex = defineAgent({
    description:
      "Verify a sandboxed Codex turn using Docker-managed host authentication.",
    inputSchema: Schema.toStandardSchemaV1(
      Schema.Struct({ model: Schema.String, prompt: Schema.String })
    ),
    name: "codex",
    run: async (context) => {
      const result = await context.chat({
        adapter: codexText(context.input.model, {
          authMode: "host",
          webSearchMode: "disabled",
        }),
        debug: { logger: artifacts.logger },
        messages: [{ content: context.input.prompt, role: "user" }],
        middleware: [
          withSandbox(execution.sandbox),
          otelMiddleware({ tracer: traces.tracer }),
        ],
        stream: false,
      });

      return { answer: result.text };
    },
  });

  const definition = defineHarness({
    agents: [command, codex],
    durability: { maxAttempts: 1 },
    name: "typepeek/tests",
  });

  const host = createHarnessHost({
    logger: artifacts.logger,
    observability: {
      onOperation: (report) => {
        artifacts.record("operations.jsonl", { ...report });
      },
      tracer: traces.tracer,
    },
    persistence,
  });

  return {
    artifacts,
    close: async () => {
      try {
        await host.close();
        await pending;
      } finally {
        stopLogging();
        await traces.close();
      }

      artifacts.verify();

      if (persistenceFailure !== undefined) {
        throw new Error("TanStack session log could not be exported.", {
          cause: persistenceFailure,
        });
      }
    },
    open: async () => {
      const session = await host.open(definition, {
        threadId: execution.runId,
      });

      session.onEvent((event) => {
        artifacts.record("events.jsonl", { ...event });
      });

      return session;
    },
  };
};
