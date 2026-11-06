import { mkdir, readdir } from "node:fs/promises";

/** Creates an output directory without reusing earlier artifacts. */
export const prepareOutputDirectory = async (
  directory: string,
  label: string
): Promise<void> => {
  await mkdir(directory, { recursive: true });

  const entries = await readdir(directory);

  if (entries.length > 0) {
    throw new Error(`Use an empty ${label} output directory.`);
  }
};
