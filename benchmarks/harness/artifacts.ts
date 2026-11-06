import { appendFileSync, mkdirSync } from "node:fs";
import nodePath from "node:path";

import type { Logger } from "@tanstack/ai";
import { Predicate } from "effect";

const secretKey =
  /(?:authorization|password|apikey|accesstoken|refreshtoken|bearertoken|secret)$/iu;

export type HarnessDiagnosticFields = NonNullable<
  Parameters<Logger["debug"]>[1]
>;

export const serializeHarnessArtifact = (
  value: HarnessDiagnosticFields
): string =>
  JSON.stringify(value, <Entry>(key: string, entry: Entry) => {
    if (secretKey.test(key.replaceAll(/[_-]/gu, ""))) {
      return "<REDACTED>";
    }

    if (Predicate.isString(entry)) {
      return entry.replaceAll(/Bearer\s+[a-z0-9._~-]+/giu, "Bearer <REDACTED>");
    }

    if (entry instanceof Error) {
      return { message: entry.message, name: entry.name };
    }

    return entry;
  });

export const createHarnessArtifacts = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const started = performance.now();
  let failure: unknown;

  const record = (file: string, value: HarnessDiagnosticFields): void => {
    try {
      appendFileSync(
        nodePath.join(directory, file),
        `${serializeHarnessArtifact({
          milliseconds: performance.now() - started,
          timestamp: new Date().toISOString(),
          value,
        })}\n`,
        { mode: 0o600 }
      );
    } catch (error) {
      failure ??= error;
    }
  };

  const log =
    (level: string): Logger["debug"] =>
    (message, metadata) => {
      record("tanstack.log.jsonl", { level, message, metadata });
    };

  return {
    logger: {
      debug: log("debug"),
      error: log("error"),
      info: log("info"),
      warn: log("warn"),
    } satisfies Logger,
    record,
    verify: (): void => {
      if (failure !== undefined) {
        throw new Error("Harness artifacts could not be recorded.", {
          cause: failure,
        });
      }
    },
  };
};
