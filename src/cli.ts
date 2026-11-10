#!/usr/bin/env node
import { enableCompileCache } from "#typepeek/platform/node-module";

enableCompileCache();

const { runCli } = await import("#typepeek/cli/cli-runtime");

const { runMain } = await import("@effect/platform-bun/BunRuntime");

runMain(runCli(process.argv.slice(2)), { disableErrorReporting: true });
