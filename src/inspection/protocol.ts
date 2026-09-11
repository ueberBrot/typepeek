import * as Schema from "effect/Schema";

import {
  MAX_MEMBER_CANDIDATES,
  MAX_MEMBER_MATCHES,
  MAX_MODULE_EXPORTS,
  MAX_EXPORT_INDEX_CANDIDATES,
  MAX_EXPORT_SEARCH_MATCHES,
} from "#typepeek/inspection/budget-policy";
import { exportPageSchema, isConsistentExportPage } from "#typepeek/inspection/export-pagination";
import {
  MAX_INSPECTION_PLAN_QUERIES,
  isBoundedExportSearchQuery,
} from "#typepeek/inspection/inspection-plan-query";
import {
  memberPathSchema,
  memberDiscoveryPathSchema,
  memberNameSchema,
  memberDeclarationSpaceSchema,
} from "#typepeek/inspection/member-path";
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
const moduleExportIndexSchema = Schema.Array(moduleExportIndexEntrySchema).check(
  Schema.makeFilter(
    (entries) =>
      entries.every((entry, index) => index === 0 || entries[index - 1]!.name < entry.name),
    { expected: "unique Module Export names in ascending order" },
  ),
);
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
const declarationSpaceSchema = memberDeclarationSpaceSchema;
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
// Schema.suspend requires an explicit type for this recursive structure.
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
export const signatureInspectionSchemaComponents = {
  signature: inspectedSignatureSchema,
  moduleExport: inspectedModuleExportSignaturesSchema,
} as const;
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
export const inspectionResultWithIdentity = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
) =>
  Schema.Union([
    Schema.Struct({ ...fields, ...packageIdentityFields }),
    Schema.Struct({ ...fields, ...platformIdentityFields }),
  ]);
const interfaceOverviewSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("interface-overview"),
  publicSubpaths: Schema.Array(publicSubpathSchema),
  moduleExports: moduleExportIndexSchema.check(Schema.isMaxLength(MAX_MODULE_EXPORTS)),
  exportPage: Schema.optionalKey(exportPageSchema),
}).check(
  Schema.makeFilter(
    (value) =>
      !Object.hasOwn(value, "exportPage") ||
      (value.exportPage !== undefined &&
        isConsistentExportPage(value.exportPage, value.moduleExports.length)),
    { expected: "consistent export page counts and continuation" },
  ),
);
const exportInspectionSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("export-inspection"),
  moduleExport: inspectedModuleExportSchema,
  supportingTypes: Schema.Array(supportingTypeSchema),
  packageDocumentation: Schema.optionalKey(packageDocumentationSchema),
});
const signatureInspectionSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("signature-inspection"),
  moduleExport: inspectedModuleExportSignaturesSchema,
});
const exportSearchSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("export-search"),
  query: Schema.String,
  totalModuleExports: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_EXPORT_INDEX_CANDIDATES)),
  matches: moduleExportIndexSchema.check(Schema.isMaxLength(MAX_EXPORT_SEARCH_MATCHES)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.matches.length <= value.totalModuleExports &&
      value.matches.every(({ name }) => name.toLowerCase().includes(value.query.toLowerCase())),
    { expected: "Module Export matches consistent with the search query and candidate count" },
  ),
);
const publicSubpathDiscoverySchema = inspectionResultWithIdentity({
  intent: Schema.Literal("public-subpath-discovery"),
  publicSubpaths: Schema.Array(publicSubpathSchema),
});
const declarationInspectionSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("declaration-inspection"),
  moduleExport: inspectedModuleExportDeclarationsSchema,
});
const memberInspectionSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("member-inspection"),
  moduleExportName: Schema.String,
  memberPath: memberPathSchema,
  declarations: Schema.Array(inspectedDeclarationSchema).check(Schema.isMinLength(1)),
});
const memberDiscoverySchema = inspectionResultWithIdentity({
  intent: Schema.Literal("member-discovery"),
  moduleExportName: Schema.String,
  memberPath: memberDiscoveryPathSchema,
  query: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(isBoundedExportSearchQuery, { expected: "a bounded search query" }),
    ),
  ),
  totalMembers: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_MEMBER_CANDIDATES)),
  members: Schema.Array(
    Schema.Struct({
      name: memberNameSchema,
      spaces: Schema.Array(declarationSpaceSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(3),
        Schema.makeFilter(
          (spaces) =>
            spaces.every(
              (space, index) =>
                index === 0 ||
                declarationSpaceSchema.literals.indexOf(spaces[index - 1]!) <
                  declarationSpaceSchema.literals.indexOf(space),
            ),
          { expected: "unique declaration spaces in canonical order" },
        ),
      ),
    }),
  ).check(Schema.isMaxLength(MAX_MEMBER_MATCHES)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.members.length <= value.totalMembers &&
      (value.query !== undefined || value.members.length === value.totalMembers) &&
      value.members.every(
        (member, index) =>
          (index === 0 || value.members[index - 1]!.name < member.name) &&
          (value.query === undefined ||
            member.name.toLowerCase().includes(value.query.toLowerCase())),
      ),
    { expected: "unique sorted Members consistent with the search query and candidate count" },
  ),
);
const comparisonTargetSchema = inspectionResultWithIdentity({});
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
export const atomicInspectionResultSchemas = {
  "interface-overview": interfaceOverviewSchema,
  "export-inspection": exportInspectionSchema,
  "signature-inspection": signatureInspectionSchema,
  "export-search": exportSearchSchema,
  "public-subpath-discovery": publicSubpathDiscoverySchema,
  "declaration-inspection": declarationInspectionSchema,
  "member-inspection": memberInspectionSchema,
  "member-discovery": memberDiscoverySchema,
} as const;
const atomicInspectionResultSchema = Schema.Union([
  atomicInspectionResultSchemas["interface-overview"],
  atomicInspectionResultSchemas["export-inspection"],
  atomicInspectionResultSchemas["signature-inspection"],
  atomicInspectionResultSchemas["export-search"],
  atomicInspectionResultSchemas["public-subpath-discovery"],
  atomicInspectionResultSchemas["declaration-inspection"],
  atomicInspectionResultSchemas["member-inspection"],
  atomicInspectionResultSchemas["member-discovery"],
]);
const inspectionPlanSchema = Schema.Struct({
  intent: Schema.Literal("inspection-plan"),
  inspections: Schema.Array(atomicInspectionResultSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES),
  ),
});
export const inspectionResultSchemas = {
  ...atomicInspectionResultSchemas,
  "inspection-plan": inspectionPlanSchema,
  "public-interface-comparison": publicInterfaceComparisonSchema,
} as const;
const inspectionResultSchema = Schema.Union([
  inspectionResultSchemas["interface-overview"],
  inspectionResultSchemas["export-inspection"],
  inspectionResultSchemas["signature-inspection"],
  inspectionResultSchemas["export-search"],
  inspectionResultSchemas["public-subpath-discovery"],
  inspectionResultSchemas["declaration-inspection"],
  inspectionResultSchemas["member-inspection"],
  inspectionResultSchemas["member-discovery"],
  inspectionResultSchemas["inspection-plan"],
  inspectionResultSchemas["public-interface-comparison"],
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
export const inspectionFailureSchemas = {
  notFound: notFoundFailureSchema,
  unsupported: unsupportedFailureSchema,
  staticBoundary: staticBoundaryFailureSchema,
  limit: limitFailureSchema,
} as const;
export const inspectionFailureSchema = Schema.Union([
  inspectionFailureSchemas.notFound,
  inspectionFailureSchemas.unsupported,
  inspectionFailureSchemas.staticBoundary,
  inspectionFailureSchemas.limit,
]);
const inspectionSuccessSchema = Schema.Struct({
  status: Schema.Literal("success"),
  result: inspectionResultSchema,
});
export const inspectionOutcomeSchema = Schema.Union([
  inspectionSuccessSchema,
  inspectionFailureSchema,
]);

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
export type MemberDiscovery = typeof memberDiscoverySchema.Type;
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
  MemberDiscoveryRequest,
  NormalizedInspectionPlanRequest,
  NormalizedInspectionTarget,
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
