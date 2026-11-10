import { Effect } from "effect";

export const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = Math.max(Number(process.exitCode ?? 0), code);
  });

export const heapUsed = Effect.sync(() => process.memoryUsage().heapUsed);

export const exitImmediately = (code: number) =>
  Effect.sync(() => process.exit(code));

export const peakResidentBytes = (): number =>
  process.resourceUsage().maxRSS * 1024;
