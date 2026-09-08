import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { InspectionLimitError } from "#typepeek/inspection/errors";
import type { InspectionBudgetDimension } from "#typepeek/inspection/protocol-vocabulary";

const MAX_CANONICAL_CANDIDATE_DEPTH = 256;

/** Reads bounded installed evidence and rejects files larger than the caller's budget. */
export function readBoundedUtf8File(
  fileName: string,
  maxBytes: number,
  exceededBudget: InspectionBudgetDimension,
  limitMessage: string,
): string {
  const fileDescriptor = openSync(fileName, "r");
  try {
    return readBoundedUtf8(fileDescriptor, maxBytes, exceededBudget, limitMessage);
  } finally {
    closeSync(fileDescriptor);
  }
}

function readBoundedUtf8(
  fileDescriptor: number,
  maxBytes: number,
  exceededBudget: InspectionBudgetDimension,
  limitMessage: string,
): string {
  const chunks: Buffer[] = [];
  let totalBytesRead = 0;

  for (;;) {
    // Keep one sentinel byte for overflow without allocating the entire remaining budget.
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes - totalBytesRead + 1));
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
  return Buffer.concat(chunks, totalBytesRead).toString("utf8");
}

/** Checks containment with the host platform's path and case semantics. */
export function isPathWithin(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate);
  const escapesToParent = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  return relativePath === "" || (!escapesToParent && !isAbsolute(relativePath));
}

/** Returns whether one Installed Evidence path is a readable filesystem file. */
export function isEvidenceFile(fileName: string): boolean {
  try {
    return statSync(fileName).isFile();
  } catch {
    return false;
  }
}

/** Returns whether one Installed Evidence path is a readable filesystem directory. */
export function isEvidenceDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** Canonicalizes an Installed Evidence path without turning absence into authority. */
export function canonicalEvidencePath(fileName: string): string | undefined {
  try {
    return realpathSync(fileName);
  } catch {
    return undefined;
  }
}

/** Canonicalizes an evidence candidate through its nearest existing ancestor. */
export function canonicalEvidenceCandidatePath(fileName: string): string | undefined {
  let current = resolve(fileName);
  const missingSegments: string[] = [];

  for (let depth = 0; ; depth += 1) {
    if (depth > MAX_CANONICAL_CANDIDATE_DEPTH) {
      throw new InspectionLimitError(
        "compiler-host-work",
        "Inspection exceeded its compiler host work limit.",
      );
    }
    const canonicalAncestor = canonicalEvidencePath(current);
    if (canonicalAncestor !== undefined) {
      return resolve(canonicalAncestor, ...missingSegments);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    missingSegments.unshift(basename(current));
    current = parent;
  }
}
