import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function reserveDiscoveryArtifacts(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const report = await open(path, "wx");
  try {
    const trace = await open(`${path}.traces.jsonl`, "ax");
    return {
      writeReport: (text: string) => report.writeFile(text),
      appendTrace: (value: unknown) => trace.writeFile(`${JSON.stringify(value)}\n`),
      close: async () => {
        await Promise.all([report.close(), trace.close()]);
      },
    };
  } catch (error) {
    await report.close();
    await rm(path);
    throw error;
  }
}
