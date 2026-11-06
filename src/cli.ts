#!/usr/bin/env node
import { enableCompileCache } from "node:module";

enableCompileCache();

const { runCli } = await import("#typepeek/cli-runtime");

const { runMain } = await import("@effect/platform-node-shared/NodeRuntime");

runMain(runCli(process.argv.slice(2)), { disableErrorReporting: true });
