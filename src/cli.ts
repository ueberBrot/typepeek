#!/usr/bin/env node

import { runCli } from "#typepeek/cli-runtime";

await runCli(process.argv.slice(2));
