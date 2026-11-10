import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Schema } from "effect";

import { decodeJson } from "#typepeek/shared/json-data";

import { createHarnessArtifacts } from "./artifacts.ts";
import { codexSandbox } from "./codex-sandbox.ts";
import {
  removeSandboxResources,
  SANDBOX_RESOURCE_STATES,
} from "./resources.ts";

const resourceRecord = Schema.Struct({
  value: Schema.Struct({
    id: Schema.String.check(
      Schema.isPattern(
        /^typepeek-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u
      )
    ),
    state: Schema.Literals(SANDBOX_RESOURCE_STATES),
  }),
});

export const cleanupSandboxRun = async (directory: string, binary = "sbx") => {
  const resources = await readFile(
    nodePath.join(directory, "resources.jsonl"),
    "utf-8"
  );

  const pending = new Set<string>();

  for (const line of resources.split("\n").filter(Boolean)) {
    const { value } = decodeJson(resourceRecord, line);

    if (value.state === "destroyed") {
      pending.delete(value.id);
    } else {
      pending.add(value.id);
    }
  }

  const artifacts = createHarnessArtifacts(directory);

  const provider = codexSandbox({
    binary,
    onResource: (event) => {
      artifacts.record("resources.jsonl", { ...event });
      artifacts.verify();
    },
  });

  const count = pending.size;
  await removeSandboxResources(provider.destroy, pending);

  return { removed: count };
};
