import { Schema } from "effect";

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

export const analysisIntentSchema = Schema.Literals(ANALYSIS_INTENTS);
export const inspectionIntentSchema = Schema.Literals(INSPECTION_INTENTS);

const NOT_FOUND_FAILURE_REASONS = Object.freeze([
  "specifier-not-found",
  "export-not-found",
  "member-not-found",
] as const);

const UNSUPPORTED_FAILURE_REASONS = Object.freeze([
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

export const notFoundFailureReasonSchema = Schema.Literals(NOT_FOUND_FAILURE_REASONS);
export const unsupportedFailureReasonSchema = Schema.Literals(UNSUPPORTED_FAILURE_REASONS);
const inspectionFailureReasonSchema = Schema.Literals(INSPECTION_FAILURE_REASONS);

export const SIGNATURE_EVIDENCE_KINDS = Object.freeze(["structured", "exact", "both"] as const);

const signatureEvidenceKindSchema = Schema.Literals(SIGNATURE_EVIDENCE_KINDS);
export const inspectionProtocolResponseOptionsSchema = Schema.Struct({
  signatureEvidence: signatureEvidenceKindSchema,
});

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

export const inspectionBudgetDimensionSchema = Schema.Literals(INSPECTION_BUDGET_DIMENSIONS);

export type InspectionIntent = typeof inspectionIntentSchema.Type;
export type AnalysisIntent = typeof analysisIntentSchema.Type;
export type InspectionFailureReason = typeof inspectionFailureReasonSchema.Type;
export type InspectionBudgetDimension = typeof inspectionBudgetDimensionSchema.Type;
export type SignatureEvidenceKind = typeof signatureEvidenceKindSchema.Type;
