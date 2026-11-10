import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import nodePath from "node:path";

import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import type { InspectionBudgetDimension } from "#typepeek/inspection/model/protocol-vocabulary";

const MAX_CANONICAL_CANDIDATE_DEPTH = 256;
const MAX_PATH_CONTAINMENT_ENTRIES = 4096;
const normalizedPaths = new Map<string, string>();

const readBoundedUtf8 = function readBoundedUtf8(
  fileDescriptor: number,
  maxBytes: number,
  exceededBudget: InspectionBudgetDimension,
  limitMessage: string
): string {
  const chunks: Buffer[] = [];
  let totalBytesRead = 0;

  for (;;) {
    // Keep one sentinel byte for overflow without allocating the entire remaining budget.
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, maxBytes - totalBytesRead + 1)
    );

    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, null);

    if (bytesRead === 0) {
      break;
    }

    totalBytesRead += bytesRead;

    if (totalBytesRead > maxBytes) {
      throw new InspectionLimitError(exceededBudget, limitMessage);
    }

    chunks.push(buffer.subarray(0, bytesRead));
  }

  // Decode only after joining bytes, so UTF-8 characters can cross read boundaries.
  return Buffer.concat(chunks, totalBytesRead).toString("utf-8");
};

/** Reads bounded installed evidence and rejects files larger than the caller's budget. */
export const readBoundedUtf8File = function readBoundedUtf8File(
  fileName: string,
  maxBytes: number,
  exceededBudget: InspectionBudgetDimension,
  limitMessage: string
): string {
  const fileDescriptor = openSync(fileName, "r");

  try {
    return readBoundedUtf8(
      fileDescriptor,
      maxBytes,
      exceededBudget,
      limitMessage
    );
  } finally {
    closeSync(fileDescriptor);
  }
};

const normalizedAbsolutePath = function normalizedAbsolutePath(
  path: string
): string {
  const cached = normalizedPaths.get(path);

  if (cached !== undefined) {
    return cached;
  }

  const normalized = nodePath.resolve(path);

  // Cache only pure normalization. Filesystem authorization still resolves symlinks.
  if (normalizedPaths.size === MAX_PATH_CONTAINMENT_ENTRIES) {
    normalizedPaths.clear();
  }

  normalizedPaths.set(path, normalized);

  return normalized;
};

/** Checks containment with the host platform's path and case semantics. */
export const isPathWithin = function isPathWithin(
  directory: string,
  candidate: string
): boolean {
  if (
    nodePath.sep === "/" &&
    nodePath.isAbsolute(directory) &&
    nodePath.isAbsolute(candidate)
  ) {
    const root = normalizedAbsolutePath(directory);
    const path = normalizedAbsolutePath(candidate);

    return root === "/" || path === root || path.startsWith(`${root}/`);
  }

  const relativePath = nodePath.relative(directory, candidate);

  const escapesToParent =
    relativePath === ".." || relativePath.startsWith(`..${nodePath.sep}`);

  return (
    relativePath === "" ||
    (!escapesToParent && !nodePath.isAbsolute(relativePath))
  );
};

export const isEvidenceFile = function isEvidenceFile(
  fileName: string
): boolean {
  try {
    return statSync(fileName, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
};

export const isEvidenceDirectory = function isEvidenceDirectory(
  directory: string
): boolean {
  try {
    return (
      statSync(directory, { throwIfNoEntry: false })?.isDirectory() ?? false
    );
  } catch {
    return false;
  }
};

/** Returns the real path, or undefined when it is missing or unreadable. */
export const canonicalEvidencePath = function canonicalEvidencePath(
  fileName: string
): string | undefined {
  try {
    // Avoid exception allocation for missing resolution candidates.
    return existsSync(fileName) ? realpathSync.native(fileName) : undefined;
  } catch {
    return undefined;
  }
};

/** Canonicalizes an evidence candidate through its nearest existing ancestor. */
export const canonicalEvidenceCandidatePath =
  function canonicalEvidenceCandidatePath(
    fileName: string
  ): string | undefined {
    let current = nodePath.resolve(fileName);
    const missingSegments: string[] = [];

    for (let depth = 0; ; depth += 1) {
      if (depth > MAX_CANONICAL_CANDIDATE_DEPTH) {
        throw new InspectionLimitError(
          "compiler-host-work",
          "Inspection exceeded its compiler host work limit."
        );
      }

      const canonicalAncestor = canonicalEvidencePath(current);

      if (canonicalAncestor !== undefined) {
        return nodePath.resolve(canonicalAncestor, ...missingSegments);
      }

      const parent = nodePath.dirname(current);

      if (parent === current) {
        return undefined;
      }

      missingSegments.unshift(nodePath.basename(current));
      current = parent;
    }
  };
