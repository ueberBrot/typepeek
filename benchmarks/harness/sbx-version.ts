import { coerce, gte } from "semver";

export const MIN_SBX_VERSION = "0.51.0";

export const requireSupportedSbxVersion = (output: string): void => {
  const installed = coerce(output, { includePrerelease: true });

  if (installed === null || !gte(installed, MIN_SBX_VERSION)) {
    throw new Error(
      `Docker Sandboxes ${MIN_SBX_VERSION} or newer is required for --no-input and --static-mcp none. Found: ${output.trim()}`
    );
  }
};
