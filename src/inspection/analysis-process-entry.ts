import { enableCompileCache } from "#typepeek/platform/node-module";

enableCompileCache();

await import("#typepeek/inspection/execution/analysis-worker");
