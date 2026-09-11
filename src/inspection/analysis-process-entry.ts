import { enableCompileCache } from "node:module";

enableCompileCache();
await import("#typepeek/inspection/analysis-worker");
