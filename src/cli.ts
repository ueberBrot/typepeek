#!/usr/bin/env node

import { run, type StricliProcess } from "@stricli/core";

import { app } from "#typepeek/app";

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const cliProcess: StricliProcess = {
  stdout: process.stdout,
  stderr: process.stderr,
  env: environment,
  get exitCode() {
    return process.exitCode ?? null;
  },
  set exitCode(exitCode) {
    process.exitCode = exitCode ?? undefined;
  },
};

await run(app, process.argv.slice(2), { process: cliProcess });
