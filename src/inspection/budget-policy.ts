/** Cache-affecting production thresholds and their shared identity. */
export const INSPECTION_BUDGET_POLICY = {
  analysisHeapMegabytes: 384,
  declarationSourceBytes: 16 * 1_024 * 1_024,
  declarationSourceFiles: 2_048,
  declarationGraphNodes: 500_000,
  compilerHostOperations: 150_000,
  identity: "large-declaration-graphs-scoped-resolution-cache-v6",
} as const;

/** Maximum serialized stdout bytes accepted from the isolated analysis process. */
export const MAX_ANALYSIS_RESULT_BYTES = 64 * 1_024;

/** Aggregate structured-result construction limits shared by every core result. */
export const MAX_RESULT_CONSTRUCTION_BYTES = 60 * 1_024;
export const MAX_RESULT_CONSTRUCTION_NODES = 4_096;

/** Aggregate Member candidates and per-query returned-name limits. */
export const MAX_MEMBER_CANDIDATES = 4_096;
export const MAX_MEMBER_MATCHES = 256;

/** Namespace traversal depth shared by analysis and outcome validation. */
export const MAX_NAMESPACE_DEPTH = 8;
