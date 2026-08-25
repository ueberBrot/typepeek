export const INSPECTION_PROTOCOL_VERSION = "1" as const;

export const ANALYSIS_INTENTS = Object.freeze([
  "interface-overview",
  "export-inspection",
  "signature-inspection",
  "export-search",
  "public-subpath-discovery",
  "declaration-inspection",
  "member-inspection",
  "inspection-plan",
] as const);

export const INSPECTION_INTENTS = Object.freeze([
  ...ANALYSIS_INTENTS,
  "public-interface-comparison",
] as const);

export const NOT_FOUND_FAILURE_REASONS = Object.freeze([
  "specifier-not-found",
  "export-not-found",
  "member-not-found",
] as const);

export const UNSUPPORTED_FAILURE_REASONS = Object.freeze([
  "invalid-request",
  "invalid-result",
  "unsupported-protocol-version",
  "ambiguous-member",
  "no-static-representation",
  "unsupported-evidence",
  "analysis-terminated",
] as const);

export const INSPECTION_FAILURE_REASONS = Object.freeze([
  ...NOT_FOUND_FAILURE_REASONS,
  ...UNSUPPORTED_FAILURE_REASONS,
  "static-boundary",
  "budget-exceeded",
] as const);

export const INSPECTION_BUDGET_DIMENSIONS = Object.freeze([
  "request-bytes",
  "analysis-deadline",
  "analysis-memory",
  "analysis-output-bytes",
  "result-construction",
  "package-resolution",
  "package-manifest-bytes",
  "package-export-targets",
  "public-subpaths",
  "public-subpath-files",
  "compiler-host-bytes",
  "compiler-host-work",
  "declaration-files",
  "declaration-bytes",
  "declaration-graph",
  "merged-declarations",
  "declaration-output",
  "module-exports",
  "export-search-candidates",
  "export-search-matches",
  "package-documentation",
  "inferred-type-traversal",
  "namespace-depth",
  "namespace-members",
  "supporting-type-depth",
  "supporting-types",
  "supporting-type-traversal",
  "signature-bytes",
  "signatures",
  "signature-parameters",
  "signature-type-parameters",
  "standard-library-catalog",
  "terminal-output",
  "json-output",
] as const);

export type InspectionIntent = (typeof INSPECTION_INTENTS)[number];
export type AnalysisIntent = (typeof ANALYSIS_INTENTS)[number];
export type InspectionFailureReason = (typeof INSPECTION_FAILURE_REASONS)[number];
export type InspectionBudgetDimension = (typeof INSPECTION_BUDGET_DIMENSIONS)[number];
