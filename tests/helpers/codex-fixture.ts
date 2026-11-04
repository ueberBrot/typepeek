import { writeFile } from "node:fs/promises";
import nodePath from "node:path";

/** Installs an executable launcher for the typed protocol fixture. */
export const installCodexFixture = async (
  binDirectory: string
): Promise<void> => {
  const entry = new URL("../fixtures/codex-app-server.ts", import.meta.url);
  await writeFile(
    nodePath.join(binDirectory, "codex"),
    [
      "#!/usr/bin/env node",
      `await import(${JSON.stringify(entry.href)});`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
};
