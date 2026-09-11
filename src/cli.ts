#!/usr/bin/env node

import { enableCompileCache } from "node:module";

enableCompileCache();
const { runCli } = await import("#typepeek/cli-runtime");
await runCli(process.argv.slice(2));
