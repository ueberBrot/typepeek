import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { InspectionLimitError } from "#typepeek/inspection/errors";
import type { InspectionBudgetDimension } from "#typepeek/inspection/protocol-vocabulary";

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
  // The sentinel byte proves overflow without reading the complete untrusted file.
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let totalBytesRead = 0;

  while (totalBytesRead < buffer.length) {
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }

  if (totalBytesRead > maxBytes) {
    throw new InspectionLimitError(exceededBudget, limitMessage);
  }
  return buffer.toString("utf8", 0, totalBytesRead);
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
