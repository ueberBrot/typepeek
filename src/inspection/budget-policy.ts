/**
 * Cache identity for the complete budget policy documented by ADR-0004.
 * Bump this single value whenever any inspection threshold or accounting rule changes.
 */
export const INSPECTION_BUDGET_POLICY_VERSION = "adr-0004-v2" as const;

/** Maximum serialized stdout bytes accepted from the isolated analysis process. */
export const MAX_ANALYSIS_RESULT_BYTES = 64 * 1_024;

/** Aggregate structured-result construction limits shared by every core result. */
export const MAX_RESULT_CONSTRUCTION_BYTES = 60 * 1_024;
export const MAX_RESULT_CONSTRUCTION_NODES = 4_096;
