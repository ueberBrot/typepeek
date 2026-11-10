import { enableCompileCache } from "node:module";

enableCompileCache();

await import("#typepeek/inspection/execution/analysis-worker");
