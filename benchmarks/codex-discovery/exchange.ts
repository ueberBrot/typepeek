import { Schema } from "effect";

import type { JsonInput } from "#typepeek/shared/json-data";

import type { CodexLaunch } from "./capture.ts";

const threadSchema = Schema.Struct({
  activePermissionProfile: Schema.Struct({ id: Schema.Literal("discovery") }),
  instructionSources: Schema.Array(Schema.String),
  model: Schema.String,
  thread: Schema.Struct({ id: Schema.String }),
});

const skillsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      errors: Schema.Array(Schema.Unknown),
      skills: Schema.Array(Schema.Struct({ path: Schema.String })),
    })
  ),
});

export interface CodexExchange {
  readonly launch: CodexLaunch;
  readonly finished: Promise<undefined>;
  readonly request: (
    method: string,
    params: JsonInput
  ) => Promise<Schema.Json | undefined>;
  readonly send: (value: JsonInput) => boolean;
  readonly onSubmit: (threadId: string) => void;
  readonly onCleanup: () => void;
}

export const runCodexExchange = async (
  context: CodexExchange
): Promise<void> => {
  const { launch, request, send } = context;
  await request("initialize", {
    capabilities: { experimentalApi: true },
    clientInfo: { name: "typepeek_benchmark", version: "1" },
  });
  send({ method: "initialized", params: {} });

  const skills = Schema.decodeUnknownSync(skillsSchema)(
    await request("skills/list", {
      cwds: [launch.workspace],
      forceReload: true,
    })
  );

  if (skills.data.some(({ errors }) => errors.length > 0)) {
    throw new Error("Host skill discovery failed; cannot verify isolation.");
  }

  const thread = Schema.decodeUnknownSync(threadSchema)(
    await request("thread/start", {
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      config: {
        "skills.config": skills.data.flatMap(({ skills: availableSkills }) =>
          availableSkills.map(({ path }) => ({ enabled: false, path }))
        ),
      },
      cwd: launch.workspace,
      ephemeral: true,
      experimentalRawEvents: true,
      model: launch.model,
      permissions: "discovery",
    })
  );

  if (thread.model !== launch.model) {
    throw new Error("Codex substituted the requested model.");
  }

  if (thread.instructionSources.length !== 0) {
    throw new Error("Host instructions leaked into the benchmark thread.");
  }

  const threadId = thread.thread.id;
  context.onSubmit(threadId);
  await request("turn/start", {
    effort: launch.effort,
    input: [{ text: launch.prompt, type: "text" }],
    threadId,
    ...(launch.outputSchema !== undefined && {
      outputSchema: launch.outputSchema,
    }),
  });
  await context.finished;
  context.onCleanup();
  await request("thread/backgroundTerminals/clean", { threadId });
};
