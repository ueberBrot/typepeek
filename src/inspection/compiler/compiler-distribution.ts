import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import nodePath from "node:path";

import { typescriptVersion, version } from "tsrs";

export const COMPILER_VERSION = `${typescriptVersion}/tsrs-${version}`;

export { typescriptVersion as COMPILER_TYPESCRIPT_VERSION } from "tsrs";

/** Resolve only the native dependency belonging to Typepeek's pinned SDK. */
const platformDirectory = (): string => {
  const require = createRequire(
    createRequire(import.meta.url).resolve("tsrs/package.json")
  );

  const base = `@tsrs/${process.platform}-${process.arch}`;

  const candidates =
    process.platform === "linux" ? [`${base}-gnu`, `${base}-musl`] : [base];

  for (const candidate of candidates) {
    try {
      const root = nodePath.dirname(
        require.resolve(`${candidate}/package.json`)
      );

      if (
        existsSync(
          nodePath.join(
            root,
            process.platform === "win32" ? "tsrs.exe" : "tsrs"
          )
        )
      ) {
        return root;
      }
    } catch {
      // Unsupported optional platform dependencies are absent from this installation.
    }
  }

  throw new Error(
    `The pinned TSRS native dependency is missing for ${process.platform}-${process.arch}.`
  );
};

export const COMPILER_LIBRARY_DIRECTORY = platformDirectory();

export const COMPILER_EXECUTABLE = nodePath.join(
  COMPILER_LIBRARY_DIRECTORY,
  process.platform === "win32" ? "tsrs.exe" : "tsrs"
);

export const COMPILER_INTRINSIC_FILE = nodePath.join(
  COMPILER_LIBRARY_DIRECTORY,
  "__typepeek_intrinsics__.d.ts"
);

export const COMPILER_INTRINSIC_SOURCE = "export type EmptyArguments = [];";
