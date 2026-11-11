import { Effect, Schema } from "effect";

export const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = Math.max(Number(process.exitCode ?? 0), code);
  });

export const heapUsed = Effect.sync(() => process.memoryUsage().heapUsed);

export const exitImmediately = (code: number) =>
  Effect.sync(() => process.exit(code));

export const peakResidentBytes = (): number =>
  process.resourceUsage().maxRSS * 1024;

export const reportLibc = Effect.sync((): "gnu" | "musl" => {
  const report = process.report.getReport();

  return Schema.is(
    Schema.Struct({
      header: Schema.Struct({ glibcVersionRuntime: Schema.String }),
    })
  )(report)
    ? "gnu"
    : "musl";
});
