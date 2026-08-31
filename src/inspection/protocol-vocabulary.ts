import { Schema } from "effect";

export const INSPECTION_PROTOCOL_VERSION = "1" as const;

export const analysisIntentSchema = Schema.Literals([
  "interface-overview",
  "export-inspection",
  "signature-inspection",
  "export-search",
  "public-subpath-discovery",
  "declaration-inspection",
  "member-inspection",
  "inspection-plan",
] as const);
export const ANALYSIS_INTENTS = Object.freeze(analysisIntentSchema.literals);

export const inspectionIntentSchema = Schema.Literals([
  ...ANALYSIS_INTENTS,
  "public-interface-comparison",
] as const);
export const INSPECTION_INTENTS = Object.freeze(inspectionIntentSchema.literals);

export const notFoundFailureReasonSchema = Schema.Literals([
  "specifier-not-found",
  "export-not-found",
  "member-not-found",
] as const);
const NOT_FOUND_FAILURE_REASONS = Object.freeze(notFoundFailureReasonSchema.literals);

export const unsupportedFailureReasonSchema = Schema.Literals([
  "invalid-request",
  "invalid-result",
  "unsupported-protocol-version",
  "ambiguous-member",
  "no-static-representation",
  "unsupported-evidence",
  "analysis-terminated",
] as const);
const UNSUPPORTED_FAILURE_REASONS = Object.freeze(unsupportedFailureReasonSchema.literals);

const inspectionFailureReasonSchema = Schema.Literals([
  ...NOT_FOUND_FAILURE_REASONS,
  ...UNSUPPORTED_FAILURE_REASONS,
  "static-boundary",
  "budget-exceeded",
] as const);
export const INSPECTION_FAILURE_REASONS = Object.freeze(inspectionFailureReasonSchema.literals);

export const signatureEvidenceKindSchema = Schema.Literals([
  "structured",
  "exact",
  "both",
] as const);
export const signatureEvidenceIntentSchema = Schema.Literals([
  "signature-inspection",
  "inspection-plan",
] as const);
export const SIGNATURE_EVIDENCE_INTENTS = Object.freeze(signatureEvidenceIntentSchema.literals);
export const inspectionProtocolResponseOptionsSchema = Schema.Struct({
  signatureEvidence: signatureEvidenceKindSchema,
});

export const inspectionBudgetDimensionSchema = Schema.Literals([
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
export const INSPECTION_BUDGET_DIMENSIONS = Object.freeze(inspectionBudgetDimensionSchema.literals);

export const protocolRecoveryReasonSchemas = {
  declarationsWithoutSupportingTypes: Schema.Literal(
    "inspect-declarations-without-supporting-types",
  ),
  signaturesWithoutSupportingTypes: Schema.Literal("inspect-signatures-without-supporting-types"),
  relatedExportNames: Schema.Literal("search-related-export-names"),
} as const;
export const PROTOCOL_RECOVERY_REASONS = Object.freeze([
  protocolRecoveryReasonSchemas.declarationsWithoutSupportingTypes.literal,
  protocolRecoveryReasonSchemas.signaturesWithoutSupportingTypes.literal,
  protocolRecoveryReasonSchemas.relatedExportNames.literal,
] as const);

export const supportingTypeRecoveryBudgetSchema = Schema.Literals([
  "supporting-type-depth",
  "supporting-types",
  "supporting-type-traversal",
] as const);

export const protocolRecoveryPolicySchema = Schema.Struct({
  maximumEntries: Schema.Literal(2),
  maximumBytes: Schema.Literal(32_768),
});
export const PROTOCOL_RECOVERY_POLICY = Object.freeze(
  Schema.decodeSync(protocolRecoveryPolicySchema)({
    maximumEntries: 2,
    maximumBytes: 32_768,
  }),
);

export type InspectionIntent = typeof inspectionIntentSchema.Type;
export type AnalysisIntent = typeof analysisIntentSchema.Type;
export type InspectionBudgetDimension = typeof inspectionBudgetDimensionSchema.Type;
export type SignatureEvidenceKind = typeof signatureEvidenceKindSchema.Type;
export type SignatureEvidenceIntent = typeof signatureEvidenceIntentSchema.Type;
