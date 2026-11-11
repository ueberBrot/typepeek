import { Effect, FileSystem } from "effect";

import { reportLibc } from "#typepeek/platform/runtime-process";

export const nativePackageName = (
  platform: string,
  architecture: string,
  libc: "gnu" | "musl" = "gnu"
): string | undefined => {
  if (architecture !== "arm64" && architecture !== "x64") {
    return undefined;
  }

  if (platform === "darwin") {
    return `typepeek-darwin-${architecture}`;
  }

  if (platform === "linux") {
    return `typepeek-linux-${architecture}-${libc}`;
  }

  return platform === "win32" && architecture === "x64"
    ? "typepeek-win32-x64"
    : undefined;
};

export const hostNativePackage = Effect.gen(function* hostNativePackage() {
  if (process.platform !== "linux") {
    return nativePackageName(process.platform, process.arch);
  }

  const fs = yield* FileSystem.FileSystem;

  const loader = yield* fs
    .readFileString("/usr/bin/ldd")
    .pipe(Effect.orElseSucceed(() => ""));

  if (loader.includes("musl")) {
    return nativePackageName("linux", process.arch, "musl");
  }

  if (loader.length > 0) {
    return nativePackageName("linux", process.arch, "gnu");
  }

  return nativePackageName("linux", process.arch, yield* reportLibc);
});
