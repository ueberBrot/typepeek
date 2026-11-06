import { existsSync, watch } from "node:fs";
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { execa } from "execa";

const root = process.env["TYPEPEEK_SBX_FIXTURE_ROOT"];

if (root === undefined) {
  throw new Error("Sandbox fixture requires its temporary directory.");
}

const args = process.argv
  .slice(2)
  .filter((argument) => argument !== "--no-input");

await appendFile(
  nodePath.join(root, "commands.jsonl"),
  `${JSON.stringify(args)}\n`
);

const command = args.shift();

if (command === undefined) {
  throw new Error("Sandbox fixture requires a command.");
}

switch (command) {
  case "create": {
    const name = args[args.indexOf("--name") + 1];

    if (
      name === undefined ||
      !args.includes("codex") ||
      args.includes("--quiet")
    ) {
      throw new Error("Expected current Codex provisioning arguments.");
    }

    const pause = nodePath.join(root, "pause-create");

    if (existsSync(pause)) {
      const released = Promise.withResolvers<undefined>();

      const watcher = watch(pause, () => {
        if (!existsSync(pause)) {
          watcher.close();
          released.resolve(undefined);
        }
      });

      watcher.once("error", released.reject);
      await writeFile(nodePath.join(root, "create-started"), "");
      await released.promise;
    }

    await mkdir(nodePath.join(root, "guests", name), { recursive: true });

    if (existsSync(nodePath.join(root, "fail-create"))) {
      throw new Error("Sandbox fixture failed after allocating its resource.");
    }

    break;
  }

  case "ls": {
    const names = await readdir(nodePath.join(root, "guests"));
    process.stdout.write(JSON.stringify(names.map((name) => ({ name }))));
    break;
  }

  case "exec": {
    const separator = args.indexOf("--");
    const name = args[separator + 1];
    const script = args[separator + 4];

    if (name === undefined || script === undefined) {
      throw new Error("Expected a named sandbox and shell command.");
    }

    if (script.includes("codex exec --experimental-json")) {
      for (const event of [
        { thread_id: "sandbox-thread", type: "thread.started" },
        { type: "turn.started" },
        {
          item: {
            id: "answer",
            text: "TYPEPEEK_SANDBOX_READY",
            type: "agent_message",
          },
          type: "item.completed",
        },
        {
          type: "turn.completed",
          usage: { cached_input_tokens: 0, input_tokens: 10, output_tokens: 2 },
        },
      ]) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }

      break;
    }

    const result = await execa("sh", ["-c", script], {
      cwd: nodePath.join(root, "guests", name),
      reject: false,
      stderr: "inherit",
      stdout: "inherit",
    });

    process.exitCode = result.exitCode ?? 1;
    break;
  }

  case "rm": {
    if (existsSync(nodePath.join(root, "fail-remove"))) {
      throw new Error("Sandbox fixture could not remove the resource.");
    }

    const name = args.at(-1);

    if (name === undefined) {
      throw new Error("Expected a sandbox name.");
    }

    await rm(nodePath.join(root, "guests", name), {
      force: true,
      recursive: true,
    });
    break;
  }

  case "policy": {
    if (
      args[0] !== "allow" ||
      args[1] !== "network" ||
      args[2] !== "--sandbox"
    ) {
      throw new Error("Only per-sandbox inference access is permitted.");
    }

    break;
  }

  default: {
    throw new Error(`Sandbox fixture rejected host command: ${command}`);
  }
}
