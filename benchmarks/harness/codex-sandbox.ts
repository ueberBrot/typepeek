import type {
  ExecResult,
  SandboxCreateInput,
  SandboxHandle,
  SandboxProvider,
} from "@tanstack/ai-sandbox";
import { sbxSandbox } from "@tanstack/ai-sandbox-docker";

import { runCommand } from "#typepeek/process-command";
import type { CommandCaptureOptions } from "#typepeek/process-command";

import type { SandboxResourceEvent } from "./resources.ts";
import { removeSandboxResources } from "./resources.ts";

export interface SandboxCommandEvent extends ExecResult {
  readonly command: string;
}

export interface CodexSandboxOptions {
  readonly binary?: string;
  readonly workspace?: string;
  readonly cpus?: number;
  readonly memory?: string;
  readonly setupNetwork?: boolean;
  readonly onResource?: (event: SandboxResourceEvent) => void;
  readonly onCommand?: (event: SandboxCommandEvent) => void;
}

export interface OwnedCodexSandbox extends SandboxProvider {
  readonly close: () => Promise<void>;
}

export const codexSandboxCreateArguments = (
  id: string,
  options: CodexSandboxOptions
): string[] => {
  if (!/^[a-z0-9][a-z0-9.-]+$/iu.test(id) || id === "default") {
    throw new Error("Invalid Docker sandbox name.");
  }

  return [
    "--no-input",
    "create",
    "--name",
    id,
    "--no-progress",
    "--skills",
    "off",
    "--static-mcp",
    "none",
    "--cpus",
    String(options.cpus ?? 2),
    "--memory",
    options.memory ?? "4g",
    ...(options.workspace === undefined ? [] : ["--clone"]),
    "codex",
    ...(options.workspace === undefined ? [] : [options.workspace]),
  ];
};

/** Provision Docker's Codex auth configuration, then use TanStack's handle. */
export const codexSandbox = (
  options: CodexSandboxOptions = {}
): OwnedCodexSandbox => {
  const binary = options.binary ?? "sbx";
  const transport = sbxSandbox({ sbxBinary: binary });
  const owned = new Set<string>();
  const pending = new Set<Promise<SandboxHandle>>();
  let closed = false;

  const recordCommands = (handle: SandboxHandle): SandboxHandle => {
    const execute = handle.process.exec;
    handle.process.exec = async (command, processOptions) => {
      const result = await execute(command, processOptions);
      options.onCommand?.({ command, ...result });

      return result;
    };

    return handle;
  };

  const destroy: SandboxProvider["destroy"] = async (input) => {
    try {
      await transport.destroy(input);
      owned.delete(input.id);
      options.onResource?.({ id: input.id, state: "destroyed" });
    } catch (error) {
      options.onResource?.({ id: input.id, state: "cleanup-failed" });
      throw error;
    }
  };

  const create = async (input: SandboxCreateInput): Promise<SandboxHandle> => {
    input.signal?.throwIfAborted();

    if (closed) {
      throw new Error("The sandbox owner has already closed.");
    }

    if (input.env !== undefined && Object.keys(input.env).length > 0) {
      throw new Error("Codex sandboxes use Docker-managed host OAuth.");
    }

    const id = `typepeek-${crypto.randomUUID()}`;

    const processOptions: CommandCaptureOptions =
      input.signal === undefined
        ? { stdin: "ignore" }
        : { signal: input.signal, stdin: "ignore" };

    owned.add(id);

    try {
      options.onResource?.({ id, state: "creating" });
      await runCommand(
        binary,
        codexSandboxCreateArguments(id, options),
        processOptions
      );
      const hosts = ["chatgpt.com"];

      if (options.setupNetwork === true) {
        hosts.push("registry.npmjs.org", "nodejs.org");
      }

      await Array.fromAsync(hosts, async (host) => {
        await runCommand(
          binary,
          ["--no-input", "policy", "allow", "network", "--sandbox", id, host],
          processOptions
        );
      });
      const resumeInput: Parameters<SandboxProvider["resume"]>[0] = { id };

      if (input.signal !== undefined) {
        resumeInput.signal = input.signal;
      }

      const handle = await transport.resume(resumeInput);

      if (closed) {
        throw new Error("The sandbox owner has already closed.");
      }

      if (handle === null) {
        throw new Error("Docker did not expose the created Codex sandbox.");
      }

      options.onResource?.({ id, state: "ready" });

      return recordCommands(handle);
    } catch (error) {
      await destroy({ id });
      throw error;
    }
  };

  return {
    capabilities: () => transport.capabilities(),
    close: async () => {
      closed = true;
      await Promise.allSettled(pending);
      await removeSandboxResources(destroy, owned);
    },
    create: async (input) => {
      const creation = Promise.resolve().then(async () => await create(input));
      pending.add(creation);

      try {
        return await creation;
      } finally {
        pending.delete(creation);
      }
    },
    destroy,
    name: "sbx",
    resume: async (input) => {
      const handle = await transport.resume(input);

      return handle === null ? null : recordCommands(handle);
    },
  };
};
