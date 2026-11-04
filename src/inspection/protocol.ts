import { Predicate, Schema } from "effect";

import { requireDefined } from "#typepeek/defined-value";
import {
  MAX_EXPORT_INDEX_CANDIDATES,
  MAX_EXPORT_SEARCH_MATCHES,
  MAX_MEMBER_CANDIDATES,
  MAX_MEMBER_MATCHES,
  MAX_MODULE_EXPORTS,
} from "#typepeek/inspection/budget-policy";
import {
  exportPageSchema,
  isConsistentExportPage,
} from "#typepeek/inspection/export-pagination";
import {
  MAX_INSPECTION_PLAN_QUERIES,
  exportSearchScopeSchema,
  isBoundedExportSearchQuery,
} from "#typepeek/inspection/inspection-plan-query";
import {
  memberDeclarationSpaceSchema,
  memberDiscoveryPathSchema,
  memberNameSchema,
  memberPathSchema,
} from "#typepeek/inspection/member-path";
import { packageIdentitySchema } from "#typepeek/inspection/package-identity";
import type { InspectionIntent } from "#typepeek/inspection/protocol-vocabulary";
import {
  inspectionBudgetDimensionSchema,
  notFoundFailureReasonSchema,
  unsupportedFailureReasonSchema,
} from "#typepeek/inspection/protocol-vocabulary";

const isPortableRelativePath = function isPortableRelativePath(
  value: unknown
): value is string {
  if (
    !Predicate.isString(value) ||
    value.length === 0 ||
    value.includes("\\")
  ) {
    return false;
  }

  const segments = value.split("/");

  return (
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    )
  );
};

const portableRelativePathSchema = Schema.String.check(
  Schema.makeFilter(isPortableRelativePath, {
    expected: "a portable relative path",
  })
);

const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const accessStyleSchema = Schema.Literals(["import", "require"]);
const omittedFieldSchema = Schema.optionalKey(Schema.Never);
const moduleExportIndexEntrySchema = Schema.Struct({ name: Schema.String });

const moduleExportIndexSchema = Schema.Array(
  moduleExportIndexEntrySchema
).check(
  Schema.makeFilter(
    (entries) =>
      entries.every(
        (entry, index) =>
          index === 0 || requireDefined(entries[index - 1]).name < entry.name
      ),
    { expected: "unique Module Export names in ascending order" }
  )
);

const publicSubpathSchema = Schema.Struct({ specifier: Schema.String });

export const packageInspectionResultIdentitySchema = Schema.Struct({
  declarationProvider: Schema.optionalKey(packageIdentitySchema),
  packageIdentity: packageIdentitySchema,
});

export const platformInspectionResultIdentitySchema = Schema.Struct({
  declarationProvider: packageIdentitySchema,
  packageIdentity: omittedFieldSchema,
});

const inspectionResultIdentitySchema = Schema.Union([
  packageInspectionResultIdentitySchema,
  platformInspectionResultIdentitySchema,
]);

const resolutionVariantSchema = Schema.Struct({
  accessStyle: accessStyleSchema,
});

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
  column: positiveIntegerSchema,
  file: portableRelativePathSchema,
  line: positiveIntegerSchema,
  packageIdentity: packageIdentitySchema,
});

const inspectedDeclarationSchema = Schema.Struct({
  kind: declarationKindSchema,
  provenance: declarationProvenanceSchema,
  text: Schema.String,
});

const aliasDeclarationSchema = Schema.Struct({
  kind: Schema.Literal("alias"),
  provenance: declarationProvenanceSchema,
  text: Schema.String,
});

const exportTypeOrValueDeclarationSpaceSchema = Schema.Struct({
  declarations: Schema.Array(inspectedDeclarationSchema),
  space: Schema.Literals(["type", "value"]),
});

// Schema.suspend requires an explicit type for this recursive structure.
export interface ExportNamespaceMember {
  readonly name: string;
  readonly declarations: readonly (typeof inspectedDeclarationSchema.Type)[];
  readonly members: readonly ExportNamespaceMember[];
}

const exportNamespaceMemberSchema: Schema.Codec<ExportNamespaceMember> =
  Schema.Struct({
    declarations: Schema.Array(inspectedDeclarationSchema),
    members: Schema.Array(
      Schema.suspend(
        (): Schema.Codec<ExportNamespaceMember> => exportNamespaceMemberSchema
      )
    ),
    name: Schema.String,
  });

const exportNamespaceDeclarationSpaceSchema = Schema.Struct({
  members: Schema.Array(exportNamespaceMemberSchema),
  space: Schema.Literal("namespace"),
});

const exportDeclarationSpaceSchema = Schema.Union([
  exportTypeOrValueDeclarationSpaceSchema,
  exportNamespaceDeclarationSpaceSchema,
]);

const exportAliasSchema = Schema.Struct({
  declaration: aliasDeclarationSchema,
  targetName: Schema.String,
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
  optional: Schema.Boolean,
  rest: Schema.Boolean,
  type: Schema.String,
});

const signatureThisParameterSchema = Schema.Struct({ type: Schema.String });

const signatureTypeParameterModifierSchema = Schema.Literals([
  "const",
  "in",
  "out",
]);

const signatureTypeParameterSchema = Schema.Struct({
  constraint: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.String),
  modifiers: Schema.Array(signatureTypeParameterModifierSchema),
  name: Schema.String,
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
  parameters: Schema.Array(signatureParameterSchema),
  returns: signatureReturnSchema,
  text: Schema.String,
  thisParameter: Schema.optionalKey(signatureThisParameterSchema),
  typeParameters: Schema.Array(signatureTypeParameterSchema),
});

const inspectedModuleExportSchema = Schema.Struct({
  alias: Schema.optionalKey(exportAliasSchema),
  name: Schema.String,
  signatures: Schema.Array(exportSignatureSchema),
  spaces: Schema.Array(exportDeclarationSpaceSchema),
});

const inspectedModuleExportSignaturesSchema = Schema.Struct({
  aliasTargetName: Schema.optionalKey(Schema.String),
  name: Schema.String,
  signatures: Schema.Array(inspectedSignatureSchema),
});

export const signatureInspectionSchemaComponents = {
  moduleExport: inspectedModuleExportSignaturesSchema,
  signature: inspectedSignatureSchema,
} as const;

const inspectedModuleExportDeclarationsSchema = Schema.Struct({
  alias: Schema.optionalKey(exportAliasSchema),
  name: Schema.String,
  spaces: Schema.Array(exportDeclarationSpaceSchema),
});

const supportingTypeSchema = Schema.Struct({
  declarations: Schema.Array(inspectedDeclarationSchema),
  name: Schema.String,
});

const packageDocumentationSchema = Schema.Struct({
  provenance: Schema.Literal("installed-evidence"),
  text: Schema.String,
  trust: Schema.Literal("untrusted"),
});

const packageIdentityFields = {
  resolutionVariant: resolutionVariantSchema,
  specifier: Schema.String,
  ...packageInspectionResultIdentitySchema.fields,
} as const;

const platformIdentityFields = {
  resolutionVariant: resolutionVariantSchema,
  specifier: Schema.String,
  ...platformInspectionResultIdentitySchema.fields,
} as const;

export const inspectionResultWithIdentity = <
  const Fields extends Schema.Struct.Fields,
>(
  fields: Fields
) =>
  Schema.Union([
    Schema.Struct({ ...fields, ...packageIdentityFields }),
    Schema.Struct({ ...fields, ...platformIdentityFields }),
  ]);

const interfaceOverviewSchema = inspectionResultWithIdentity({
  exportPage: Schema.optionalKey(exportPageSchema),
  intent: Schema.Literal("interface-overview"),
  moduleExports: moduleExportIndexSchema.check(
    Schema.isMaxLength(MAX_MODULE_EXPORTS)
  ),
  publicSubpaths: Schema.Array(publicSubpathSchema),
}).check(
  Schema.makeFilter(
    (value) =>
      !Object.hasOwn(value, "exportPage") ||
      (value.exportPage !== undefined &&
        isConsistentExportPage(value.exportPage, value.moduleExports.length)),
    { expected: "consistent export page counts and continuation" }
  )
);

const exportInspectionSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("export-inspection"),
  moduleExport: inspectedModuleExportSchema,
  packageDocumentation: Schema.optionalKey(packageDocumentationSchema),
  supportingTypes: Schema.Array(supportingTypeSchema),
});

const signatureInspectionSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("signature-inspection"),
  moduleExport: inspectedModuleExportSignaturesSchema,
});

const exportSearchSchema = inspectionResultWithIdentity({
  intent: Schema.Literal("export-search"),
  matches: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      packageDocumentation: Schema.optionalKey(
        Schema.Struct({
          ...packageDocumentationSchema.fields,
          excerpt: Schema.Literal(true),
        })
      ),
      signatures: Schema.optionalKey(Schema.Array(exportSignatureSchema)),
    })
  ).check(Schema.isMaxLength(MAX_EXPORT_SEARCH_MATCHES)),
  query: Schema.String,
  scope: exportSearchScopeSchema,
  totalModuleExports: Schema.Natural.check(
    Schema.isLessThanOrEqualTo(MAX_EXPORT_INDEX_CANDIDATES)
  ),
}).check(
  Schema.makeFilter(
    (value) =>
      value.matches.length <= value.totalModuleExports &&
      value.matches.every((match, index) => {
        if (
          !(
            index === 0 ||
            requireDefined(value.matches[index - 1]).name < match.name
          )
        ) {
          return false;
        }

        const query = value.query.toLowerCase();
        const matchesName = match.name.toLowerCase().includes(query);

        if (value.scope !== "documentation") {
          return (
            match.signatures === undefined &&
            match.packageDocumentation === undefined &&
            matchesName
          );
        }

        if (match.signatures === undefined) {
          return false;
        }

        return (
          matchesName ||
          match.packageDocumentation?.text.toLowerCase().includes(query) ===
            true
        );
      }),
    {
      expected:
        "Module Export matches consistent with the search query and candidate count",
    }
  )
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
  declarations: Schema.Array(inspectedDeclarationSchema).check(
    Schema.isMinLength(1)
  ),
  intent: Schema.Literal("member-inspection"),
  memberPath: memberPathSchema,
  moduleExportName: Schema.String,
});

const memberDiscoverySchema = inspectionResultWithIdentity({
  intent: Schema.Literal("member-discovery"),
  memberPath: memberDiscoveryPathSchema,
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
                declarationSpaceSchema.literals.indexOf(
                  requireDefined(spaces[index - 1])
                ) < declarationSpaceSchema.literals.indexOf(space)
            ),
          { expected: "unique declaration spaces in canonical order" }
        )
      ),
    })
  ).check(Schema.isMaxLength(MAX_MEMBER_MATCHES)),
  moduleExportName: Schema.String,
  query: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(isBoundedExportSearchQuery, {
        expected: "a bounded search query",
      })
    )
  ),
  totalMembers: Schema.Natural.check(
    Schema.isLessThanOrEqualTo(MAX_MEMBER_CANDIDATES)
  ),
}).check(
  Schema.makeFilter(
    (value) =>
      value.members.length <= value.totalMembers &&
      (value.query !== undefined ||
        value.members.length === value.totalMembers) &&
      value.members.every(
        (member, index) =>
          (index === 0 ||
            requireDefined(value.members[index - 1]).name < member.name) &&
          (value.query === undefined ||
            member.name.toLowerCase().includes(value.query.toLowerCase()))
      ),
    {
      expected:
        "unique sorted Members consistent with the search query and candidate count",
    }
  )
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
  after: comparisonTargetSchema,
  before: comparisonTargetSchema,
  intent: Schema.Literal("public-interface-comparison"),
  moduleExports: moduleExportIndexDeltaSchema,
  publicSubpaths: publicSubpathIndexDeltaSchema,
  scope: Schema.Literal("interface-overview"),
});

export const atomicInspectionResultSchemas = {
  "declaration-inspection": declarationInspectionSchema,
  "export-inspection": exportInspectionSchema,
  "export-search": exportSearchSchema,
  "interface-overview": interfaceOverviewSchema,
  "member-discovery": memberDiscoverySchema,
  "member-inspection": memberInspectionSchema,
  "public-subpath-discovery": publicSubpathDiscoverySchema,
  "signature-inspection": signatureInspectionSchema,
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
  inspections: Schema.Array(atomicInspectionResultSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES)
  ),
  intent: Schema.Literal("inspection-plan"),
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
  message: Schema.String,
  reason: notFoundFailureReasonSchema,
  status: Schema.Literal("not-found"),
});

const unsupportedFailureSchema = Schema.Struct({
  message: Schema.String,
  reason: unsupportedFailureReasonSchema,
  status: Schema.Literal("unsupported"),
});

const staticBoundaryFailureSchema = Schema.Struct({
  message: Schema.String,
  reason: Schema.Literal("static-boundary"),
  status: Schema.Literal("static-boundary"),
});

const limitFailureSchema = Schema.Struct({
  exceededBudget: inspectionBudgetDimensionSchema,
  message: Schema.String,
  reason: Schema.Literal("budget-exceeded"),
  status: Schema.Literal("limit-exceeded"),
});

export const inspectionFailureSchemas = {
  limit: limitFailureSchema,
  notFound: notFoundFailureSchema,
  staticBoundary: staticBoundaryFailureSchema,
  unsupported: unsupportedFailureSchema,
} as const;

export const inspectionFailureSchema = Schema.Union([
  inspectionFailureSchemas.notFound,
  inspectionFailureSchemas.unsupported,
  inspectionFailureSchemas.staticBoundary,
  inspectionFailureSchemas.limit,
]);

const inspectionSuccessSchema = Schema.Struct({
  result: inspectionResultSchema,
  status: Schema.Literal("success"),
});

export const inspectionOutcomeSchema = Schema.Union([
  inspectionSuccessSchema,
  inspectionFailureSchema,
]);

export type PublicSubpath = typeof publicSubpathSchema.Type;

export type { PackageIdentity } from "#typepeek/inspection/package-identity";

export type ResolutionVariant = typeof resolutionVariantSchema.Type;

export type InspectionResultIdentity =
  typeof inspectionResultIdentitySchema.Type;

export type InterfaceOverview = typeof interfaceOverviewSchema.Type;

export type DeclarationSpace = typeof declarationSpaceSchema.Type;

export type DeclarationKind = typeof declarationKindSchema.Type;

export type InspectedDeclaration = typeof inspectedDeclarationSchema.Type;

export type ExportDeclarationSpace = typeof exportDeclarationSpaceSchema.Type;

export type ExportAlias = typeof exportAliasSchema.Type;

export type ExportSignature = typeof exportSignatureSchema.Type;

export type SignatureBinding = typeof signatureBindingSchema.Type;

export type SignatureParameter = typeof signatureParameterSchema.Type;

export type SignatureTypeParameterModifier =
  typeof signatureTypeParameterModifierSchema.Type;

export type SignatureTypeParameter = typeof signatureTypeParameterSchema.Type;

export type SignatureReturn = typeof signatureReturnSchema.Type;

export type InspectedSignature = typeof inspectedSignatureSchema.Type;

export type InspectedModuleExport = typeof inspectedModuleExportSchema.Type;

export type SupportingType = typeof supportingTypeSchema.Type;

export type PackageDocumentation = typeof packageDocumentationSchema.Type;

export type ExportInspection = typeof exportInspectionSchema.Type;

export type InspectedModuleExportSignatures =
  typeof inspectedModuleExportSignaturesSchema.Type;

export type SignatureInspection = typeof signatureInspectionSchema.Type;

export type ExportSearch = typeof exportSearchSchema.Type;

export type PublicSubpathDiscovery = typeof publicSubpathDiscoverySchema.Type;

export type InspectedModuleExportDeclarations =
  typeof inspectedModuleExportDeclarationsSchema.Type;

export type DeclarationInspection = typeof declarationInspectionSchema.Type;

export type MemberDiscovery = typeof memberDiscoverySchema.Type;

export type MemberInspection = typeof memberInspectionSchema.Type;

export type PublicInterfaceComparisonTarget =
  typeof comparisonTargetSchema.Type;

export type PublicInterfaceComparison =
  typeof publicInterfaceComparisonSchema.Type;

export type AtomicInspectionResult = typeof atomicInspectionResultSchema.Type;

export type InspectionPlan = typeof inspectionPlanSchema.Type;

export type InspectionResult = typeof inspectionResultSchema.Type;

export type InspectionFailure = typeof inspectionFailureSchema.Type;

export type InspectionResultByIntent = {
  readonly [Intent in InspectionIntent]: Extract<
    InspectionResult,
    {
      readonly intent: Intent;
    }
  >;
};

/** A complete Inspection Result or an explicit non-authoritative failure. */
export type InspectionOutcome<
  Result extends InspectionResult = InspectionResult,
> =
  | (Omit<typeof inspectionSuccessSchema.Type, "result"> & {
      readonly result: Result;
    })
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
  MemberDiscoveryRequest,
  MemberInspectionRequest,
  NormalizedInspectionPlanRequest,
  NormalizedInspectionTarget,
  NormalizedPublicInterfaceComparisonRequest,
  PublicInterfaceComparisonRequest,
  PublicSubpathDiscoveryRequest,
  SignatureInspectionRequest,
} from "#typepeek/inspection/request-definitions";

export type { InspectionPlanQuery } from "#typepeek/inspection/inspection-plan-query";
