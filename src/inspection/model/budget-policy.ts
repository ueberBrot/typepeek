/** Change the identity whenever a threshold or accounting rule changes. */
export const INSPECTION_BUDGET_POLICY = {
  analysisDeadlineMilliseconds: 30_000,
  analysisHeapMegabytes: 384,
  compilerHostOperations: 150_000,
  declarationGraphNodes: 500_000,
  declarationSourceBytes: 16 * 1024 * 1024,
  declarationSourceFiles: 2048,
  identity: "tsrs-async-queries-v10",
} as const;

/** Maximum serialized stdout bytes accepted from the isolated analysis process. */
export const MAX_ANALYSIS_RESULT_BYTES = 64 * 1024;

/** Aggregate limits for each result, including all queries in a plan. */
export const MAX_RESULT_CONSTRUCTION_BYTES = 60 * 1024;
export const MAX_RESULT_CONSTRUCTION_NODES = 4096;
export const MAX_MODULE_EXPORTS = 320;
export const MAX_EXPORT_INDEX_CANDIDATES = 16_384;
export const MAX_EXPORT_SEARCH_MATCHES = 320;

/** Aggregate Member candidates and per-query returned-name limits. */
export const MAX_MEMBER_CANDIDATES = 4096;
export const MAX_MEMBER_MATCHES = 256;
export const MAX_NAMESPACE_DEPTH = 8;
