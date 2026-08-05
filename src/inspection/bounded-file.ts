import { closeSync, openSync, readSync } from "node:fs";

import { InspectionLimitError } from "#typepeek/inspection/errors";

export function readBoundedUtf8File(
  fileName: string,
  maxBytes: number,
  limitMessage: string,
): string {
  const fileDescriptor = openSync(fileName, "r");
  try {
    return readBoundedUtf8(fileDescriptor, maxBytes, limitMessage);
  } finally {
    closeSync(fileDescriptor);
  }
}

function readBoundedUtf8(fileDescriptor: number, maxBytes: number, limitMessage: string): string {
  // The sentinel byte proves that the file exceeds the budget without ever
  // allocating or reading the complete untrusted file.
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
    throw new InspectionLimitError(limitMessage);
  }
  return buffer.toString("utf8", 0, totalBytesRead);
}
