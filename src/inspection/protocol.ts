import { Result, Schema } from "effect";

import {
  inspectionPlanQueriesForRequest,
  MAX_INSPECTION_PLAN_QUERIES,
} from "#typepeek/inspection/inspection-plan-query";
import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import {
  INSPECTION_BUDGET_DIMENSIONS,
  NOT_FOUND_FAILURE_REASONS,
  UNSUPPORTED_FAILURE_REASONS,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  readOwnDataProperty,
  snapshotBoundedDataPropertyGraph,
} from "#typepeek/inspection/untrusted-data";

const MAX_PROTOCOL_GRAPH_OBJECTS = 4_096;
const MAX_PROTOCOL_GRAPH_VALUES = 16_384;

const portableRelativePathSchema = Schema.String.check(
  Schema.makeFilter(isPortableRelativePath, { expected: "a portable relative path" }),
);
const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const accessStyleSchema = Schema.Literals(["import", "require"]);
const budgetDimensionSchema = Schema.Literals(INSPECTION_BUDGET_DIMENSIONS);
const notFoundFailureReasonSchema = Schema.Literals(NOT_FOUND_FAILURE_REASONS);
const unsupportedFailureReasonSchema = Schema.Literals(UNSUPPORTED_FAILURE_REASONS);
const optionalUndefined = Schema.optional(Schema.Never);

const moduleExportIndexEntrySchema = Schema.Struct({ name: Schema.String });
const publicSubpathSchema = Schema.Struct({ specifier: Schema.String });
const packageIdentitySchema = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
});
export const packageInspectionResultIdentitySchema = Schema.Struct({
  packageIdentity: packageIdentitySchema,
  declarationProvider: Schema.optional(packageIdentitySchema),
});
export const platformInspectionResultIdentitySchema = Schema.Struct({
  packageIdentity: optionalUndefined,
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
interface ExportNamespaceMemberSchemaType {
  readonly name: string;
  readonly declarations: ReadonlyArray<typeof inspectedDeclarationSchema.Type>;
  readonly members: ReadonlyArray<ExportNamespaceMemberSchemaType>;
}
const exportNamespaceMemberSchema: Schema.Codec<ExportNamespaceMemberSchemaType> = Schema.Struct({
  name: Schema.String,
  declarations: Schema.Array(inspectedDeclarationSchema),
  members: Schema.Array(
    Schema.suspend(
      (): Schema.Codec<ExportNamespaceMemberSchemaType> => exportNamespaceMemberSchema,
    ),
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
  constraint: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
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
  type: Schema.optional(Schema.String),
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
  thisParameter: Schema.optional(signatureThisParameterSchema),
  parameters: Schema.Array(signatureParameterSchema),
  returns: signatureReturnSchema,
});
const inspectedModuleExportSchema = Schema.Struct({
  name: Schema.String,
  alias: Schema.optional(exportAliasSchema),
  spaces: Schema.Array(exportDeclarationSpaceSchema),
  signatures: Schema.Array(exportSignatureSchema),
});
const inspectedModuleExportSignaturesSchema = Schema.Struct({
  name: Schema.String,
  aliasTargetName: Schema.optional(Schema.String),
  signatures: Schema.Array(inspectedSignatureSchema),
});
const inspectedModuleExportDeclarationsSchema = Schema.Struct({
  name: Schema.String,
  alias: Schema.optional(exportAliasSchema),
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
  packageDocumentation: Schema.optional(packageDocumentationSchema),
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
  exceededBudget: budgetDimensionSchema,
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
const inspectionOutcomeSchema = Schema.Union([inspectionSuccessSchema, inspectionFailureSchema]);

const STRICT_PROTOCOL_PARSE_OPTIONS = { onExcessProperty: "error" } as const;
const decodeInspectionOutcome = Schema.decodeUnknownResult(
  inspectionOutcomeSchema,
  STRICT_PROTOCOL_PARSE_OPTIONS,
);

/**
 * Projects schema-inferred protocol values into readonly TypeScript shapes.
 * Optional properties stay optional rather than becoming required properties
 * whose values include `undefined`.
 */
export type ProtocolType<Value> = Value extends readonly (infer Item)[]
  ? readonly ProtocolType<Item>[]
  : Value extends object
    ? {
        readonly [Key in keyof Value as {} extends Pick<Value, Key> ? never : Key]: ProtocolType<
          Value[Key]
        >;
      } & {
        readonly [Key in keyof Value as {} extends Pick<Value, Key> ? Key : never]?: ProtocolType<
          Exclude<Value[Key], undefined>
        >;
      }
    : Value;

export type AccessStyle = ProtocolType<typeof accessStyleSchema.Type>;
export interface InterfaceOverviewRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle?: AccessStyle;
}
export interface NormalizedInspectionTarget {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle: AccessStyle;
}
export type NormalizedInterfaceOverviewRequest = NormalizedInspectionTarget;
export interface ExportInspectionRequest extends InterfaceOverviewRequest {
  readonly exportName: string;
}
export interface NormalizedExportInspectionRequest extends NormalizedInspectionTarget {
  readonly exportName: string;
}
export interface SignatureInspectionRequest extends InterfaceOverviewRequest {
  readonly exportName: string;
}
export interface NormalizedSignatureInspectionRequest extends NormalizedInspectionTarget {
  readonly exportName: string;
}
export interface ExportSearchRequest extends InterfaceOverviewRequest {
  readonly query: string;
}
export interface NormalizedExportSearchRequest extends NormalizedInspectionTarget {
  readonly query: string;
}
export type PublicSubpathDiscoveryRequest = InterfaceOverviewRequest;
export type NormalizedPublicSubpathDiscoveryRequest = NormalizedInspectionTarget;
export type DeclarationInspectionRequest = ExportInspectionRequest;
export type NormalizedDeclarationInspectionRequest = NormalizedExportInspectionRequest;
export interface MemberInspectionRequest extends ExportInspectionRequest {
  readonly memberPath: readonly string[];
}
export interface NormalizedMemberInspectionRequest extends NormalizedExportInspectionRequest {
  readonly memberPath: readonly string[];
}
export type InspectionPlanQuery =
  | { readonly intent: "interface-overview" }
  | { readonly intent: "export-inspection"; readonly exportName: string }
  | { readonly intent: "signature-inspection"; readonly exportName: string }
  | { readonly intent: "export-search"; readonly query: string }
  | { readonly intent: "public-subpath-discovery" }
  | { readonly intent: "declaration-inspection"; readonly exportName: string }
  | {
      readonly intent: "member-inspection";
      readonly exportName: string;
      readonly memberPath: readonly string[];
    };
export interface InspectionPlanRequest extends InterfaceOverviewRequest {
  readonly queries: readonly InspectionPlanQuery[];
}
export interface NormalizedInspectionPlanRequest extends NormalizedInspectionTarget {
  readonly queries: readonly InspectionPlanQuery[];
}
export interface PublicInterfaceComparisonRequest {
  readonly before: InterfaceOverviewRequest;
  readonly after: InterfaceOverviewRequest;
}
export interface NormalizedPublicInterfaceComparisonRequest {
  readonly before: NormalizedInterfaceOverviewRequest;
  readonly after: NormalizedInterfaceOverviewRequest;
}
export type ModuleExportIndexEntry = ProtocolType<typeof moduleExportIndexEntrySchema.Type>;
export type PublicSubpath = ProtocolType<typeof publicSubpathSchema.Type>;
export type PackageIdentity = ProtocolType<typeof packageIdentitySchema.Type>;
export type ResolutionVariant = ProtocolType<typeof resolutionVariantSchema.Type>;
export type InspectionResultIdentity = ProtocolType<typeof inspectionResultIdentitySchema.Type>;
export type InterfaceOverview = ProtocolType<typeof interfaceOverviewSchema.Type>;
export type DeclarationSpace = ProtocolType<typeof declarationSpaceSchema.Type>;
export type DeclarationKind = ProtocolType<typeof declarationKindSchema.Type>;
export type InspectedDeclaration = ProtocolType<typeof inspectedDeclarationSchema.Type>;
export type ExportNamespaceMember = ProtocolType<typeof exportNamespaceMemberSchema.Type>;
export type ExportDeclarationSpace = ProtocolType<typeof exportDeclarationSpaceSchema.Type>;
export type ExportAlias = ProtocolType<typeof exportAliasSchema.Type>;
export type ExportSignature = ProtocolType<typeof exportSignatureSchema.Type>;
export type SignatureBinding = ProtocolType<typeof signatureBindingSchema.Type>;
export type SignatureParameter = ProtocolType<typeof signatureParameterSchema.Type>;
export type SignatureThisParameter = ProtocolType<typeof signatureThisParameterSchema.Type>;
export type SignatureTypeParameterModifier = ProtocolType<
  typeof signatureTypeParameterModifierSchema.Type
>;
export type SignatureTypeParameter = ProtocolType<typeof signatureTypeParameterSchema.Type>;
export type SignatureReturn = ProtocolType<typeof signatureReturnSchema.Type>;
export type InspectedSignature = ProtocolType<typeof inspectedSignatureSchema.Type>;
export type InspectedModuleExport = ProtocolType<typeof inspectedModuleExportSchema.Type>;
export type SupportingType = ProtocolType<typeof supportingTypeSchema.Type>;
export type PackageDocumentation = ProtocolType<typeof packageDocumentationSchema.Type>;
export type ExportInspection = ProtocolType<typeof exportInspectionSchema.Type>;
export type InspectedModuleExportSignatures = ProtocolType<
  typeof inspectedModuleExportSignaturesSchema.Type
>;
export type SignatureInspection = ProtocolType<typeof signatureInspectionSchema.Type>;
export type ExportSearch = ProtocolType<typeof exportSearchSchema.Type>;
export type PublicSubpathDiscovery = ProtocolType<typeof publicSubpathDiscoverySchema.Type>;
export type InspectedModuleExportDeclarations = ProtocolType<
  typeof inspectedModuleExportDeclarationsSchema.Type
>;
export type DeclarationInspection = ProtocolType<typeof declarationInspectionSchema.Type>;
export type MemberInspection = ProtocolType<typeof memberInspectionSchema.Type>;
export type PublicInterfaceComparisonTarget = ProtocolType<typeof comparisonTargetSchema.Type>;
export type PublicInterfaceComparison = ProtocolType<typeof publicInterfaceComparisonSchema.Type>;
export type AtomicInspectionResult = ProtocolType<typeof atomicInspectionResultSchema.Type>;
export type InspectionPlan = ProtocolType<typeof inspectionPlanSchema.Type>;
export type InspectionResult = ProtocolType<typeof inspectionResultSchema.Type>;
export type InspectionFailure = ProtocolType<typeof inspectionFailureSchema.Type>;

/** A complete Inspection Result or an explicit non-authoritative failure. */
export type InspectionOutcome<Result extends InspectionResult = InspectionResult> =
  | {
      readonly status: "success";
      readonly result: Result;
    }
  | InspectionFailure;

export interface InspectionRequestByIntent {
  readonly "interface-overview": InterfaceOverviewRequest;
  readonly "export-inspection": ExportInspectionRequest;
  readonly "signature-inspection": SignatureInspectionRequest;
  readonly "export-search": ExportSearchRequest;
  readonly "public-subpath-discovery": PublicSubpathDiscoveryRequest;
  readonly "declaration-inspection": DeclarationInspectionRequest;
  readonly "member-inspection": MemberInspectionRequest;
  readonly "inspection-plan": InspectionPlanRequest;
  readonly "public-interface-comparison": PublicInterfaceComparisonRequest;
}

export type InspectionRequestReading<Request> =
  | {
      readonly accepted: true;
      readonly request: Request;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

export type AnalysisRequest =
  | { readonly intent: "interface-overview"; readonly request: NormalizedInspectionTarget }
  | { readonly intent: "export-inspection"; readonly request: NormalizedExportInspectionRequest }
  | {
      readonly intent: "signature-inspection";
      readonly request: NormalizedSignatureInspectionRequest;
    }
  | { readonly intent: "export-search"; readonly request: NormalizedExportSearchRequest }
  | {
      readonly intent: "public-subpath-discovery";
      readonly request: NormalizedPublicSubpathDiscoveryRequest;
    }
  | {
      readonly intent: "declaration-inspection";
      readonly request: NormalizedDeclarationInspectionRequest;
    }
  | { readonly intent: "member-inspection"; readonly request: NormalizedMemberInspectionRequest }
  | { readonly intent: "inspection-plan"; readonly request: NormalizedInspectionPlanRequest };

export type AnalysisRequestReading =
  | {
      readonly accepted: true;
      readonly request: AnalysisRequest;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

const INVALID_RESULT_OUTCOME: InspectionFailure = {
  status: "unsupported",
  reason: "invalid-result",
  message: "Inspection returned an invalid result.",
};

/**
 * Accepts only a bounded, dense, data-property-only outcome for the requested
 * intent. Invalid process messages collapse to a generic failure rather than
 * exposing analyzer or transport details.
 */
export function enforceInspectionOutcome(
  intent: "interface-overview",
  value: unknown,
): InspectionOutcome<InterfaceOverview>;
export function enforceInspectionOutcome(
  intent: "export-inspection",
  value: unknown,
): InspectionOutcome<ExportInspection>;
export function enforceInspectionOutcome(
  intent: "signature-inspection",
  value: unknown,
): InspectionOutcome<SignatureInspection>;
export function enforceInspectionOutcome(
  intent: "inspection-plan",
  value: unknown,
): InspectionOutcome<InspectionPlan>;
export function enforceInspectionOutcome(
  intent: "export-search",
  value: unknown,
): InspectionOutcome<ExportSearch>;
export function enforceInspectionOutcome(
  intent: "public-subpath-discovery",
  value: unknown,
): InspectionOutcome<PublicSubpathDiscovery>;
export function enforceInspectionOutcome(
  intent: "declaration-inspection",
  value: unknown,
): InspectionOutcome<DeclarationInspection>;
export function enforceInspectionOutcome(
  intent: "member-inspection",
  value: unknown,
): InspectionOutcome<MemberInspection>;
export function enforceInspectionOutcome(
  intent: "public-interface-comparison",
  value: unknown,
): InspectionOutcome<PublicInterfaceComparison>;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome {
  try {
    const outcome = readInspectionOutcome(value);
    if (outcome === undefined) {
      return INVALID_RESULT_OUTCOME;
    }
    return outcome.status !== "success" || outcome.result.intent === intent
      ? outcome
      : INVALID_RESULT_OUTCOME;
  } catch {
    return INVALID_RESULT_OUTCOME;
  }
}

/** Requires a complete outcome correlated with every selector in the normalized request. */
export function enforceAnalysisRequestOutcome(
  request: AnalysisRequest,
  value: unknown,
): InspectionOutcome {
  if (request.intent === "inspection-plan") {
    return enforceInspectionPlanOutcome(request.request, value);
  }
  if (request.intent === "declaration-inspection") {
    return enforceDeclarationInspectionOutcome(request.request, value);
  }
  if (request.intent === "member-inspection") {
    return enforceMemberInspectionOutcome(request.request, value);
  }
  const outcome = enforceInspectionOutcome(request.intent, value);
  return outcome.status !== "success" || simpleResultMatchesRequest(outcome.result, request)
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

function simpleResultMatchesRequest(
  result: InspectionResult,
  request: Exclude<
    AnalysisRequest,
    { readonly intent: "inspection-plan" | "declaration-inspection" | "member-inspection" }
  >,
): boolean {
  const query = inspectionPlanQueriesForRequest(request)[0];
  return (
    query !== undefined &&
    result.intent !== "inspection-plan" &&
    result.intent !== "public-interface-comparison" &&
    inspectionMatchesTarget(result, request.request) &&
    inspectionMatchesPlanQuery(result, query)
  );
}

/** Requires one complete result matching each ordered plan query exactly once. */
export function enforceInspectionPlanOutcome(
  request: NormalizedInspectionPlanRequest,
  value: unknown,
): InspectionOutcome<InspectionPlan> {
  const outcome = enforceInspectionOutcome("inspection-plan", value);
  if (outcome.status !== "success") {
    return outcome;
  }
  const sharedIdentity = outcome.result.inspections[0];
  return sharedIdentity !== undefined &&
    outcome.result.inspections.length === request.queries.length &&
    outcome.result.inspections.every(
      (inspection, index) =>
        inspectionMatchesTarget(inspection, request) &&
        inspectionMatchesIdentity(inspection, sharedIdentity) &&
        inspectionMatchesPlanQuery(inspection, request.queries[index]),
    )
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

/** Requires a declaration-only result for the exact requested Module Export. */
export function enforceDeclarationInspectionOutcome(
  request: NormalizedDeclarationInspectionRequest,
  value: unknown,
): InspectionOutcome<DeclarationInspection> {
  const outcome = enforceInspectionOutcome("declaration-inspection", value);
  return outcome.status !== "success" ||
    (inspectionMatchesTarget(outcome.result, request) &&
      outcome.result.moduleExport.name === request.exportName)
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

/** Requires a bounded Member result for the exact requested export and path. */
export function enforceMemberInspectionOutcome(
  request: NormalizedMemberInspectionRequest,
  value: unknown,
): InspectionOutcome<MemberInspection> {
  const outcome = enforceInspectionOutcome("member-inspection", value);
  if (outcome.status !== "success") {
    return outcome;
  }
  return inspectionMatchesTarget(outcome.result, request) &&
    outcome.result.moduleExportName === request.exportName &&
    memberPathsEqual(outcome.result.memberPath, request.memberPath) &&
    isAuthoritativeMemberInspection(outcome.result)
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

function inspectionMatchesTarget(
  inspection: AtomicInspectionResult,
  target: NormalizedInspectionTarget,
): boolean {
  return (
    inspection.specifier === target.specifier &&
    inspection.resolutionVariant.accessStyle === target.accessStyle
  );
}

function inspectionMatchesIdentity(
  inspection: AtomicInspectionResult,
  expected: AtomicInspectionResult,
): boolean {
  return (
    packageIdentitiesEqual(
      readOwnOptionalProperty(inspection, "packageIdentity"),
      readOwnOptionalProperty(expected, "packageIdentity"),
    ) &&
    packageIdentitiesEqual(
      readOwnOptionalProperty(inspection, "declarationProvider"),
      readOwnOptionalProperty(expected, "declarationProvider"),
    )
  );
}

function packageIdentitiesEqual(
  left: PackageIdentity | undefined,
  right: PackageIdentity | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.name === right.name &&
      readOwnOptionalProperty(left, "version") === readOwnOptionalProperty(right, "version"))
  );
}

function readOwnOptionalProperty<Value extends object, Key extends keyof Value & string>(
  value: Value,
  key: Key,
): Value[Key] | undefined {
  const entry = readOwnDataProperty(value, key);
  return entry?.[1] as Value[Key] | undefined;
}

function inspectionMatchesPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery | undefined,
): boolean {
  if (query === undefined || inspection.intent !== query.intent) {
    return false;
  }
  return INSPECTION_PLAN_QUERY_MATCHERS[query.intent](inspection, query);
}

type InspectionPlanQueryMatcher = (
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery,
) => boolean;

const INSPECTION_PLAN_QUERY_MATCHERS = {
  "interface-overview": () => true,
  "public-subpath-discovery": () => true,
  "export-search": (inspection, query) =>
    inspection.intent === "export-search" &&
    query.intent === "export-search" &&
    inspection.query === query.query,
  "export-inspection": matchesFocusedPlanQuery,
  "signature-inspection": matchesFocusedPlanQuery,
  "declaration-inspection": matchesFocusedPlanQuery,
  "member-inspection": matchesMemberPlanQuery,
} as const satisfies Readonly<Record<InspectionPlanQuery["intent"], InspectionPlanQueryMatcher>>;

function matchesFocusedPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery,
): boolean {
  return (
    (inspection.intent === "export-inspection" ||
      inspection.intent === "signature-inspection" ||
      inspection.intent === "declaration-inspection") &&
    (query.intent === "export-inspection" ||
      query.intent === "signature-inspection" ||
      query.intent === "declaration-inspection") &&
    inspection.moduleExport.name === query.exportName
  );
}

function matchesMemberPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery,
): boolean {
  return (
    inspection.intent === "member-inspection" &&
    query.intent === "member-inspection" &&
    inspection.moduleExportName === query.exportName &&
    memberPathsEqual(inspection.memberPath, query.memberPath) &&
    isAuthoritativeMemberInspection(inspection)
  );
}

function isAuthoritativeMemberInspection(inspection: MemberInspection): boolean {
  return (
    readBoundedMemberPath(inspection.memberPath) !== undefined && inspection.declarations.length > 0
  );
}

function memberPathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function readInspectionOutcome(value: unknown): InspectionOutcome | undefined {
  // Snapshot own data before Schema so cyclic, sparse, accessor-backed,
  // inherited, or excessively deep values cannot make validation unsafe.
  const snapshot = snapshotBoundedDataPropertyGraph(value, {
    maximumObjects: MAX_PROTOCOL_GRAPH_OBJECTS,
    maximumValues: MAX_PROTOCOL_GRAPH_VALUES,
  });
  if (snapshot === undefined || !hasBoundedNamespaceGraph(snapshot)) {
    return undefined;
  }
  return Result.getOrUndefined(decodeInspectionOutcome(snapshot)) as InspectionOutcome | undefined;
}

function hasBoundedNamespaceGraph(value: unknown): boolean {
  // Namespace members are the protocol's recursive shape. Keep this transport
  // guard aligned with the analyzer depth budget and reject object cycles.
  if (!isRecord(value) || value["status"] !== "success") {
    return true;
  }
  const result = value["result"];
  if (!isRecord(result)) {
    return true;
  }
  const inspections =
    result["intent"] === "inspection-plan" && Array.isArray(result["inspections"])
      ? result["inspections"]
      : [result];
  return everyArrayItem(inspections, hasBoundedInspectionNamespaceGraph);
}

function hasBoundedInspectionNamespaceGraph(result: unknown): boolean {
  if (!isRecord(result) || result["intent"] !== "export-inspection") {
    return true;
  }
  const moduleExport = result["moduleExport"];
  if (!isRecord(moduleExport) || !Array.isArray(moduleExport["spaces"])) {
    return true;
  }

  return everyArrayItem(moduleExport["spaces"], (space) => {
    if (!isRecord(space) || space["space"] !== "namespace" || !Array.isArray(space["members"])) {
      return true;
    }
    return everyArrayItem(space["members"], (member) =>
      hasBoundedNamespaceMember(member, new Set(), 0),
    );
  });
}

function hasBoundedNamespaceMember(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (depth > 8 || (isRecord(value) && ancestors.has(value))) {
    return false;
  }
  if (!isRecord(value) || !Array.isArray(value["members"])) {
    return true;
  }

  ancestors.add(value);
  const valid = everyArrayItem(value["members"], (member) =>
    hasBoundedNamespaceMember(member, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return valid;
}

function everyArrayItem(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean,
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!predicate(values[index])) {
      return false;
    }
  }
  return true;
}

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
