import nodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCommand } from "#typepeek/platform/process-command";

import {
  discoveryCliArguments,
  selectDiscoveryWorkloads,
} from "../benchmarks/support/workloads.ts";

const sourceEntry = nodePath.resolve("src/cli.ts");
const nativeEntry = process.env["TYPEPEEK_NATIVE_CLI"];

const runtimes = [
  { executable: "bun", name: "Bun", prefix: [sourceEntry] },
  ...(nativeEntry === undefined
    ? []
    : [
        {
          executable: nodePath.resolve(nativeEntry),
          name: "compiled Bun",
          prefix: [],
        },
      ]),
];

describe.each(runtimes)("$name inspection compatibility", (runtime) => {
  it.each(selectDiscoveryWorkloads())(
    "matches Node for $id",
    async (workload) => {
      const args = discoveryCliArguments(workload);

      const options = {
        env: { TYPEPEEK_CACHE_BYPASS: "1", TYPEPEEK_PROFILE: "0" },
        reject: false,
        timeout: 30_000,
      } as const;

      const control = await runCommand(
        process.execPath,
        [sourceEntry, ...args],
        options
      );

      const candidate = await runCommand(
        runtime.executable,
        [...runtime.prefix, ...args],
        options
      );

      expect(control).toMatchObject({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      });
      expect(candidate).toMatchObject({
        exitCode: 0,
        stderr: "",
        stdout: control.stdout,
        timedOut: false,
      });
    }
  );
});
