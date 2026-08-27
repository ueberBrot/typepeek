import { Schema } from "effect";

import { MAX_INSPECTION_PLAN_QUERIES } from "#typepeek/inspection/inspection-plan-query";
import { packageIdentitySchema } from "#typepeek/inspection/package-identity";
import {
  inspectionBudgetDimensionSchema,
  type InspectionIntent,
  notFoundFailureReasonSchema,
  unsupportedFailureReasonSchema,
} from "#typepeek/inspection/protocol-vocabulary";

const portableRelativePathSchema = Schema.String.check(
  Schema.makeFilter(isPortableRelativePath, { expected: "a portable relative path" }),
);
const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const accessStyleSchema = Schema.Literals(["import", "require"]);
const omittedFieldSchema = Schema.optionalKey(Schema.Never);

const moduleExportIndexEntrySchema = Schema.Struct({ name: Schema.String });
const publicSubpathSchema = Schema.Struct({ specifier: Schema.String });
export const packageInspectionResultIdentitySchema = Schema.Struct({
  packageIdentity: packageIdentitySchema,
  declarationProvider: Schema.optionalKey(packageIdentitySchema),
});
export const platformInspectionResultIdentitySchema = Schema.Struct({
  packageIdentity: omittedFieldSchema,
  declarationProvider: packageIdentitySchema,
});
const inspectionResultIdentitySchema = Schema.Union([
  packageInspectionResultIdentitySchema,
  platformInspectionResultIdentitySchema,
]);
const resolutionVariantSchema = Schema.Struct({ accessStyle: accessStyleSchema });
const declarationSpaceSchema = Schema.Literals(["type", "value", "namespace"]);
const declarationKindSchema = Schema.Literals([
  "accessor",
  "alias",
  "class",
  "constructor",
  "enum",
  "enum-member",
  "function",
  "interface",
  "method",
  "namespace",
  "property",
  "type-alias",
  "variable",
]);
const declarationProvenanceSchema = Schema.Struct({
  packageIdentity: packageIdentitySchema,
  file: portableRelativePathSchema,
  line: positiveIntegerSchema,
  column: positiveIntegerSchema,
});
const inspectedDeclarationSchema = Schema.Struct({
  kind: declarationKindSchema,
  text: Schema.String,
  provenance: declarationProvenanceSchema,
});
const aliasDeclarationSchema = Schema.Struct({
  kind: Schema.Literal("alias"),
  text: Schema.String,
  provenance: declarationProvenanceSchema,
});
const exportTypeOrValueDeclarationSpaceSchema = Schema.Struct({
  space: Schema.Literals(["type", "value"]),
  declarations: Schema.Array(inspectedDeclarationSchema),
});
// Schema.suspend needs a named recursive fixed point; the Codec checks its runtime definition
// against this public shape instead of maintaining an unrelated model.
export interface ExportNamespaceMember {
  readonly name: string;
  readonly declarations: ReadonlyArray<typeof inspectedDeclarationSchema.Type>;
  readonly members: ReadonlyArray<ExportNamespaceMember>;
}
const exportNamespaceMemberSchema: Schema.Codec<ExportNamespaceMember> = Schema.Struct({
  name: Schema.String,
  declarations: Schema.Array(inspectedDeclarationSchema),
  members: Schema.Array(
    Schema.suspend((): Schema.Codec<ExportNamespaceMember> => exportNamespaceMemberSchema),
  ),
});
const exportNamespaceDeclarationSpaceSchema = Schema.Struct({
  space: Schema.Literal("namespace"),
  members: Schema.Array(exportNamespaceMemberSchema),
});
const exportDeclarationSpaceSchema = Schema.Union([
  exportTypeOrValueDeclarationSpaceSchema,
  exportNamespaceDeclarationSpaceSchema,
]);
const exportAliasSchema = Schema.Struct({
  targetName: Schema.String,
  declaration: aliasDeclarationSchema,
});
const exportSignatureSchema = Schema.Struct({
  kind: Schema.Literals(["call", "construct"]),
  text: Schema.String,
});
const signatureIdentifierBindingSchema = Schema.Struct({
  kind: Schema.Literal("identifier"),
  name: Schema.String,
  synthetic: Schema.Boolean,
});
const signaturePatternBindingSchema = Schema.Struct({
  kind: Schema.Literal("pattern"),
  text: Schema.String,
});
const signatureBindingSchema = Schema.Union([
  signatureIdentifierBindingSchema,
  signaturePatternBindingSchema,
]);
const signatureParameterSchema = Schema.Struct({
  binding: signatureBindingSchema,
  type: Schema.String,
  optional: Schema.Boolean,
  rest: Schema.Boolean,
});
const signatureThisParameterSchema = Schema.Struct({ type: Schema.String });
const signatureTypeParameterModifierSchema = Schema.Literals(["const", "in", "out"]);
const signatureTypeParameterSchema = Schema.Struct({
  name: Schema.String,
  modifiers: Schema.Array(signatureTypeParameterModifierSchema),
  constraint: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.String),
  synthetic: Schema.Boolean,
});
const signatureTypeReturnSchema = Schema.Struct({
  kind: Schema.Literal("type"),
  type: Schema.String,
});
const signaturePredicateReturnSchema = Schema.Struct({
  kind: Schema.Literal("predicate"),
  parameter: Schema.String,
  type: Schema.String,
});
const signatureAssertionReturnSchema = Schema.Struct({
  kind: Schema.Literal("assertion"),
  parameter: Schema.String,
  type: Schema.optionalKey(Schema.String),
});
const signatureReturnSchema = Schema.Union([
  signatureTypeReturnSchema,
  signaturePredicateReturnSchema,
  signatureAssertionReturnSchema,
]);
const inspectedSignatureSchema = Schema.Struct({
  kind: Schema.Literals(["call", "construct"]),
  text: Schema.String,
  typeParameters: Schema.Array(signatureTypeParameterSchema),
  thisParameter: Schema.optionalKey(signatureThisParameterSchema),
  parameters: Schema.Array(signatureParameterSchema),
  returns: signatureReturnSchema,
});
const inspectedModuleExportSchema = Schema.Struct({
  name: Schema.String,
  alias: Schema.optionalKey(exportAliasSchema),
  spaces: Schema.Array(exportDeclarationSpaceSchema),
  signatures: Schema.Array(exportSignatureSchema),
});
const inspectedModuleExportSignaturesSchema = Schema.Struct({
  name: Schema.String,
  aliasTargetName: Schema.optionalKey(Schema.String),
  signatures: Schema.Array(inspectedSignatureSchema),
});
const inspectedModuleExportDeclarationsSchema = Schema.Struct({
  name: Schema.String,
  alias: Schema.optionalKey(exportAliasSchema),
  spaces: Schema.Array(exportDeclarationSpaceSchema),
});
const supportingTypeSchema = Schema.Struct({
  name: Schema.String,
  declarations: Schema.Array(inspectedDeclarationSchema),
});
const packageDocumentationSchema = Schema.Struct({
  provenance: Schema.Literal("installed-evidence"),
  trust: Schema.Literal("untrusted"),
  text: Schema.String,
});

const packageIdentityFields = {
  specifier: Schema.String,
  resolutionVariant: resolutionVariantSchema,
  ...packageInspectionResultIdentitySchema.fields,
} as const;
const platformIdentityFields = {
  specifier: Schema.String,
  resolutionVariant: resolutionVariantSchema,
  ...platformInspectionResultIdentitySchema.fields,
} as const;
const withInspectionResultIdentity = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({ ...fields, ...packageIdentityFields }),
    Schema.Struct({ ...fields, ...platformIdentityFields }),
  ]);
const interfaceOverviewSchema = withInspectionResultIdentity({
  intent: Schema.Literal("interface-overview"),
  publicSubpaths: Schema.Array(publicSubpathSchema),
  moduleExports: Schema.Array(moduleExportIndexEntrySchema),
});
const exportInspectionSchema = withInspectionResultIdentity({
  intent: Schema.Literal("export-inspection"),
  moduleExport: inspectedModuleExportSchema,
  supportingTypes: Schema.Array(supportingTypeSchema),
  packageDocumentation: Schema.optionalKey(packageDocumentationSchema),
});
const signatureInspectionSchema = withInspectionResultIdentity({
  intent: Schema.Literal("signature-inspection"),
  moduleExport: inspectedModuleExportSignaturesSchema,
});
const exportSearchSchema = withInspectionResultIdentity({
  intent: Schema.Literal("export-search"),
  query: Schema.String,
  totalModuleExports: Schema.Natural,
  matches: Schema.Array(moduleExportIndexEntrySchema),
});
const publicSubpathDiscoverySchema = withInspectionResultIdentity({
  intent: Schema.Literal("public-subpath-discovery"),
  publicSubpaths: Schema.Array(publicSubpathSchema),
});
const declarationInspectionSchema = withInspectionResultIdentity({
  intent: Schema.Literal("declaration-inspection"),
  moduleExport: inspectedModuleExportDeclarationsSchema,
});
const memberInspectionSchema = withInspectionResultIdentity({
  intent: Schema.Literal("member-inspection"),
  moduleExportName: Schema.String,
  memberPath: Schema.Array(Schema.String),
  declarations: Schema.Array(inspectedDeclarationSchema),
});
const comparisonTargetSchema = withInspectionResultIdentity({});
const moduleExportIndexDeltaSchema = Schema.Struct({
  added: Schema.Array(moduleExportIndexEntrySchema),
  removed: Schema.Array(moduleExportIndexEntrySchema),
});
const publicSubpathIndexDeltaSchema = Schema.Struct({
  added: Schema.Array(publicSubpathSchema),
  removed: Schema.Array(publicSubpathSchema),
});
const publicInterfaceComparisonSchema = Schema.Struct({
  intent: Schema.Literal("public-interface-comparison"),
  scope: Schema.Literal("interface-overview"),
  before: comparisonTargetSchema,
  after: comparisonTargetSchema,
  moduleExports: moduleExportIndexDeltaSchema,
  publicSubpaths: publicSubpathIndexDeltaSchema,
});
const atomicInspectionResultSchema = Schema.Union([
  interfaceOverviewSchema,
  exportInspectionSchema,
  signatureInspectionSchema,
  exportSearchSchema,
  publicSubpathDiscoverySchema,
  declarationInspectionSchema,
  memberInspectionSchema,
]);
const inspectionPlanSchema = Schema.Struct({
  intent: Schema.Literal("inspection-plan"),
  inspections: Schema.Array(atomicInspectionResultSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES),
  ),
});
const inspectionResultSchema = Schema.Union([
  atomicInspectionResultSchema,
  inspectionPlanSchema,
  publicInterfaceComparisonSchema,
]);
const notFoundFailureSchema = Schema.Struct({
  status: Schema.Literal("not-found"),
  reason: notFoundFailureReasonSchema,
  message: Schema.String,
});
const unsupportedFailureSchema = Schema.Struct({
  status: Schema.Literal("unsupported"),
  reason: unsupportedFailureReasonSchema,
  message: Schema.String,
});
const staticBoundaryFailureSchema = Schema.Struct({
  status: Schema.Literal("static-boundary"),
  reason: Schema.Literal("static-boundary"),
  message: Schema.String,
});
const limitFailureSchema = Schema.Struct({
  status: Schema.Literal("limit-exceeded"),
  reason: Schema.Literal("budget-exceeded"),
  exceededBudget: inspectionBudgetDimensionSchema,
  message: Schema.String,
});
const inspectionFailureSchema = Schema.Union([
  notFoundFailureSchema,
  unsupportedFailureSchema,
  staticBoundaryFailureSchema,
  limitFailureSchema,
]);
const inspectionSuccessSchema = Schema.Struct({
  status: Schema.Literal("success"),
  result: inspectionResultSchema,
});
export const inspectionOutcomeSchema = Schema.Union([
  inspectionSuccessSchema,
  inspectionFailureSchema,
]);

export type ModuleExportIndexEntry = typeof moduleExportIndexEntrySchema.Type;
export type PublicSubpath = typeof publicSubpathSchema.Type;
export type { PackageIdentity } from "#typepeek/inspection/package-identity";
export type ResolutionVariant = typeof resolutionVariantSchema.Type;
export type InspectionResultIdentity = typeof inspectionResultIdentitySchema.Type;
export type InterfaceOverview = typeof interfaceOverviewSchema.Type;
export type DeclarationSpace = typeof declarationSpaceSchema.Type;
export type DeclarationKind = typeof declarationKindSchema.Type;
export type InspectedDeclaration = typeof inspectedDeclarationSchema.Type;
export type ExportDeclarationSpace = typeof exportDeclarationSpaceSchema.Type;
export type ExportAlias = typeof exportAliasSchema.Type;
export type ExportSignature = typeof exportSignatureSchema.Type;
export type SignatureBinding = typeof signatureBindingSchema.Type;
export type SignatureParameter = typeof signatureParameterSchema.Type;
export type SignatureThisParameter = typeof signatureThisParameterSchema.Type;
export type SignatureTypeParameterModifier = typeof signatureTypeParameterModifierSchema.Type;
export type SignatureTypeParameter = typeof signatureTypeParameterSchema.Type;
export type SignatureReturn = typeof signatureReturnSchema.Type;
export type InspectedSignature = typeof inspectedSignatureSchema.Type;
export type InspectedModuleExport = typeof inspectedModuleExportSchema.Type;
export type SupportingType = typeof supportingTypeSchema.Type;
export type PackageDocumentation = typeof packageDocumentationSchema.Type;
export type ExportInspection = typeof exportInspectionSchema.Type;
export type InspectedModuleExportSignatures = typeof inspectedModuleExportSignaturesSchema.Type;
export type SignatureInspection = typeof signatureInspectionSchema.Type;
export type ExportSearch = typeof exportSearchSchema.Type;
export type PublicSubpathDiscovery = typeof publicSubpathDiscoverySchema.Type;
export type InspectedModuleExportDeclarations = typeof inspectedModuleExportDeclarationsSchema.Type;
export type DeclarationInspection = typeof declarationInspectionSchema.Type;
export type MemberInspection = typeof memberInspectionSchema.Type;
export type PublicInterfaceComparisonTarget = typeof comparisonTargetSchema.Type;
export type PublicInterfaceComparison = typeof publicInterfaceComparisonSchema.Type;
export type AtomicInspectionResult = typeof atomicInspectionResultSchema.Type;
export type InspectionPlan = typeof inspectionPlanSchema.Type;
export type InspectionResult = typeof inspectionResultSchema.Type;
export type InspectionFailure = typeof inspectionFailureSchema.Type;
export type InspectionResultByIntent = {
  readonly [Intent in InspectionIntent]: Extract<InspectionResult, { readonly intent: Intent }>;
};

/** A complete Inspection Result or an explicit non-authoritative failure. */
export type InspectionOutcome<Result extends InspectionResult = InspectionResult> =
  | (Omit<typeof inspectionSuccessSchema.Type, "result"> & { readonly result: Result })
  | InspectionFailure;

export type {
  AccessStyle,
  AnalysisRequest,
  DeclarationInspectionRequest,
  ExportInspectionRequest,
  ExportSearchRequest,
  InspectionPlanRequest,
  InspectionRequestByIntent,
  InterfaceOverviewRequest,
  MemberInspectionRequest,
  NormalizedDeclarationInspectionRequest,
  NormalizedInspectionPlanRequest,
  NormalizedInspectionTarget,
  NormalizedMemberInspectionRequest,
  NormalizedPublicInterfaceComparisonRequest,
  PublicInterfaceComparisonRequest,
  PublicSubpathDiscoveryRequest,
  SignatureInspectionRequest,
} from "#typepeek/inspection/request-definitions";
export type { InspectionPlanQuery } from "#typepeek/inspection/inspection-plan-query";

function isPortableRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return (
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
