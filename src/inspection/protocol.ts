import { type } from "arktype";

import { readBoundedMemberPath } from "#typepeek/inspection/member-path";
import {
  INSPECTION_BUDGET_DIMENSIONS,
  NOT_FOUND_FAILURE_REASONS,
  UNSUPPORTED_FAILURE_REASONS,
} from "#typepeek/inspection/protocol-vocabulary";

const MAX_PROTOCOL_GRAPH_OBJECTS = 4_096;
const MAX_PROTOCOL_GRAPH_VALUES = 16_384;

const portableRelativePathSchema = type("string").narrow(isPortableRelativePath);
const positiveIntegerSchema = type("number.integer").narrow((value) => value > 0);
const nonnegativeIntegerSchema = type("number.integer").narrow((value) => value >= 0);
const nonArrayRecordSchema = type("object").narrow((value): boolean => isRecord(value));
const budgetDimensionSchema = type.enumerated(...INSPECTION_BUDGET_DIMENSIONS);
const notFoundFailureReasonSchema = type.enumerated(...NOT_FOUND_FAILURE_REASONS);
const unsupportedFailureReasonSchema = type.enumerated(...UNSUPPORTED_FAILURE_REASONS);
const record = <const Definition extends object>(definition: Definition) =>
  [nonArrayRecordSchema, "&", definition] as const;

const inspectionSchemas = type.module({
  accessStyle: "'import' | 'require'",
  moduleExportIndexEntry: record({
    name: "string",
  }),
  publicSubpath: record({
    specifier: "string",
  }),
  packageIdentity: record({
    name: "string",
    "version?": "string | undefined",
  }),
  resolutionVariant: record({
    accessStyle: "accessStyle",
  }),
  declarationSpace: "'type' | 'value' | 'namespace'",
  declarationKind:
    "'accessor' | 'alias' | 'class' | 'constructor' | 'enum' | 'enum-member' | 'function' | 'interface' | 'method' | 'namespace' | 'property' | 'type-alias' | 'variable'",
  declarationProvenance: record({
    packageIdentity: "packageIdentity",
    file: portableRelativePathSchema,
    line: positiveIntegerSchema,
    column: positiveIntegerSchema,
  }),
  inspectedDeclaration: record({
    kind: "declarationKind",
    text: "string",
    provenance: "declarationProvenance",
  }),
  aliasDeclaration: record({
    kind: "'alias'",
    text: "string",
    provenance: "declarationProvenance",
  }),
  exportTypeOrValueDeclarationSpace: record({
    space: "'type' | 'value'",
    declarations: "inspectedDeclaration[]",
  }),
  exportNamespaceMember: record({
    name: "string",
    declarations: "inspectedDeclaration[]",
    members: "exportNamespaceMember[]",
  }),
  exportNamespaceDeclarationSpace: record({
    space: "'namespace'",
    members: "exportNamespaceMember[]",
  }),
  exportDeclarationSpace: "exportTypeOrValueDeclarationSpace | exportNamespaceDeclarationSpace",
  exportAlias: record({
    targetName: "string",
    declaration: "aliasDeclaration",
  }),
  exportSignature: record({
    kind: "'call' | 'construct'",
    text: "string",
  }),
  signatureIdentifierBinding: record({
    kind: "'identifier'",
    name: "string",
    synthetic: "boolean",
  }),
  signaturePatternBinding: record({
    kind: "'pattern'",
    text: "string",
  }),
  signatureBinding: "signatureIdentifierBinding | signaturePatternBinding",
  signatureParameter: record({
    binding: "signatureBinding",
    type: "string",
    optional: "boolean",
    rest: "boolean",
  }),
  signatureThisParameter: record({
    type: "string",
  }),
  signatureTypeParameterModifier: "'const' | 'in' | 'out'",
  signatureTypeParameter: record({
    name: "string",
    modifiers: "signatureTypeParameterModifier[]",
    "constraint?": "string | undefined",
    "default?": "string | undefined",
    synthetic: "boolean",
  }),
  signatureTypeReturn: record({
    kind: "'type'",
    type: "string",
  }),
  signaturePredicateReturn: record({
    kind: "'predicate'",
    parameter: "string",
    type: "string",
  }),
  signatureAssertionReturn: record({
    kind: "'assertion'",
    parameter: "string",
    "type?": "string | undefined",
  }),
  signatureReturn: "signatureTypeReturn | signaturePredicateReturn | signatureAssertionReturn",
  inspectedSignature: record({
    kind: "'call' | 'construct'",
    text: "string",
    typeParameters: "signatureTypeParameter[]",
    "thisParameter?": "signatureThisParameter | undefined",
    parameters: "signatureParameter[]",
    returns: "signatureReturn",
  }),
  inspectedModuleExport: record({
    name: "string",
    "alias?": "exportAlias | undefined",
    spaces: "exportDeclarationSpace[]",
    signatures: "exportSignature[]",
  }),
  inspectedModuleExportSignatures: record({
    name: "string",
    "aliasTargetName?": "string | undefined",
    signatures: "inspectedSignature[]",
  }),
  inspectedModuleExportDeclarations: record({
    name: "string",
    "alias?": "exportAlias | undefined",
    spaces: "exportDeclarationSpace[]",
  }),
  supportingType: record({
    name: "string",
    declarations: "inspectedDeclaration[]",
  }),
  packageDocumentation: record({
    provenance: "'installed-evidence'",
    trust: "'untrusted'",
    text: "string",
  }),
  packageInterfaceOverview: record({
    intent: "'interface-overview'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    publicSubpaths: "publicSubpath[]",
    moduleExports: "moduleExportIndexEntry[]",
  }),
  platformInterfaceOverview: record({
    intent: "'interface-overview'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    publicSubpaths: "publicSubpath[]",
    moduleExports: "moduleExportIndexEntry[]",
  }),
  interfaceOverview: "packageInterfaceOverview | platformInterfaceOverview",
  packageExportInspection: record({
    intent: "'export-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    moduleExport: "inspectedModuleExport",
    supportingTypes: "supportingType[]",
    "packageDocumentation?": "packageDocumentation | undefined",
  }),
  platformExportInspection: record({
    intent: "'export-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    moduleExport: "inspectedModuleExport",
    supportingTypes: "supportingType[]",
    "packageDocumentation?": "packageDocumentation | undefined",
  }),
  exportInspection: "packageExportInspection | platformExportInspection",
  packageSignatureInspection: record({
    intent: "'signature-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    moduleExport: "inspectedModuleExportSignatures",
  }),
  platformSignatureInspection: record({
    intent: "'signature-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    moduleExport: "inspectedModuleExportSignatures",
  }),
  signatureInspection: "packageSignatureInspection | platformSignatureInspection",
  packageExportSearch: record({
    intent: "'export-search'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    query: "string",
    totalModuleExports: nonnegativeIntegerSchema,
    matches: "moduleExportIndexEntry[]",
  }),
  platformExportSearch: record({
    intent: "'export-search'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    query: "string",
    totalModuleExports: nonnegativeIntegerSchema,
    matches: "moduleExportIndexEntry[]",
  }),
  exportSearch: "packageExportSearch | platformExportSearch",
  packagePublicSubpathDiscovery: record({
    intent: "'public-subpath-discovery'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    publicSubpaths: "publicSubpath[]",
  }),
  platformPublicSubpathDiscovery: record({
    intent: "'public-subpath-discovery'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    publicSubpaths: "publicSubpath[]",
  }),
  publicSubpathDiscovery: "packagePublicSubpathDiscovery | platformPublicSubpathDiscovery",
  packageDeclarationInspection: record({
    intent: "'declaration-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    moduleExport: "inspectedModuleExportDeclarations",
  }),
  platformDeclarationInspection: record({
    intent: "'declaration-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    moduleExport: "inspectedModuleExportDeclarations",
  }),
  declarationInspection: "packageDeclarationInspection | platformDeclarationInspection",
  packageMemberInspection: record({
    intent: "'member-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    moduleExportName: "string",
    memberPath: "string[]",
    declarations: "inspectedDeclaration[]",
  }),
  platformMemberInspection: record({
    intent: "'member-inspection'",
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    moduleExportName: "string",
    memberPath: "string[]",
    declarations: "inspectedDeclaration[]",
  }),
  memberInspection: "packageMemberInspection | platformMemberInspection",
  packageComparisonTarget: record({
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
  }),
  platformComparisonTarget: record({
    specifier: "string",
    resolutionVariant: "resolutionVariant",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
  }),
  comparisonTarget: "packageComparisonTarget | platformComparisonTarget",
  moduleExportIndexDelta: record({
    added: "moduleExportIndexEntry[]",
    removed: "moduleExportIndexEntry[]",
  }),
  publicSubpathIndexDelta: record({
    added: "publicSubpath[]",
    removed: "publicSubpath[]",
  }),
  publicInterfaceComparison: record({
    intent: "'public-interface-comparison'",
    scope: "'interface-overview'",
    before: "comparisonTarget",
    after: "comparisonTarget",
    moduleExports: "moduleExportIndexDelta",
    publicSubpaths: "publicSubpathIndexDelta",
  }),
  atomicInspectionResult:
    "interfaceOverview | exportInspection | signatureInspection | exportSearch | publicSubpathDiscovery | declarationInspection | memberInspection",
  inspectionResult: "atomicInspectionResult | publicInterfaceComparison",
  notFoundFailure: record({
    status: "'not-found'",
    reason: notFoundFailureReasonSchema,
    message: "string",
  }),
  unsupportedFailure: record({
    status: "'unsupported'",
    reason: unsupportedFailureReasonSchema,
    message: "string",
  }),
  staticBoundaryFailure: record({
    status: "'static-boundary'",
    reason: "'static-boundary'",
    message: "string",
  }),
  limitFailure: record({
    status: "'limit-exceeded'",
    reason: "'budget-exceeded'",
    exceededBudget: budgetDimensionSchema,
    message: "string",
  }),
  inspectionFailure: "notFoundFailure | unsupportedFailure | staticBoundaryFailure | limitFailure",
  inspectionSuccess: record({
    status: "'success'",
    result: "inspectionResult",
  }),
  inspectionOutcome: "inspectionSuccess | inspectionFailure",
});

const inspectionOutcomeSchema = inspectionSchemas.inspectionOutcome.onDeepUndeclaredKey("reject");
const atomicInspectionResultSchema =
  inspectionSchemas.atomicInspectionResult.onDeepUndeclaredKey("reject");

/**
 * Projects ArkType-inferred protocol values into readonly TypeScript shapes.
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

export type AccessStyle = ProtocolType<typeof inspectionSchemas.accessStyle.infer>;
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
export type ModuleExportIndexEntry = ProtocolType<
  typeof inspectionSchemas.moduleExportIndexEntry.infer
>;
export type PublicSubpath = ProtocolType<typeof inspectionSchemas.publicSubpath.infer>;
export type PackageIdentity = ProtocolType<typeof inspectionSchemas.packageIdentity.infer>;
export type ResolutionVariant = ProtocolType<typeof inspectionSchemas.resolutionVariant.infer>;
export type InspectionResultIdentity =
  | {
      readonly packageIdentity: PackageIdentity;
      readonly declarationProvider?: PackageIdentity;
    }
  | {
      readonly packageIdentity?: never;
      readonly declarationProvider: PackageIdentity;
    };
export type InterfaceOverview = ProtocolType<typeof inspectionSchemas.interfaceOverview.infer>;
export type DeclarationSpace = ProtocolType<typeof inspectionSchemas.declarationSpace.infer>;
export type DeclarationKind = ProtocolType<typeof inspectionSchemas.declarationKind.infer>;
export type InspectedDeclaration = ProtocolType<
  typeof inspectionSchemas.inspectedDeclaration.infer
>;
export type ExportNamespaceMember = ProtocolType<
  typeof inspectionSchemas.exportNamespaceMember.infer
>;
export type ExportDeclarationSpace = ProtocolType<
  typeof inspectionSchemas.exportDeclarationSpace.infer
>;
export type ExportAlias = ProtocolType<typeof inspectionSchemas.exportAlias.infer>;
export type ExportSignature = ProtocolType<typeof inspectionSchemas.exportSignature.infer>;
export type SignatureBinding = ProtocolType<typeof inspectionSchemas.signatureBinding.infer>;
export type SignatureParameter = ProtocolType<typeof inspectionSchemas.signatureParameter.infer>;
export type SignatureThisParameter = ProtocolType<
  typeof inspectionSchemas.signatureThisParameter.infer
>;
export type SignatureTypeParameterModifier = ProtocolType<
  typeof inspectionSchemas.signatureTypeParameterModifier.infer
>;
export type SignatureTypeParameter = ProtocolType<
  typeof inspectionSchemas.signatureTypeParameter.infer
>;
export type SignatureReturn = ProtocolType<typeof inspectionSchemas.signatureReturn.infer>;
export type InspectedSignature = ProtocolType<typeof inspectionSchemas.inspectedSignature.infer>;
export type InspectedModuleExport = ProtocolType<
  typeof inspectionSchemas.inspectedModuleExport.infer
>;
export type SupportingType = ProtocolType<typeof inspectionSchemas.supportingType.infer>;
export type PackageDocumentation = ProtocolType<
  typeof inspectionSchemas.packageDocumentation.infer
>;
export type ExportInspection = ProtocolType<typeof inspectionSchemas.exportInspection.infer>;
export type InspectedModuleExportSignatures = ProtocolType<
  typeof inspectionSchemas.inspectedModuleExportSignatures.infer
>;
export type SignatureInspection = ProtocolType<typeof inspectionSchemas.signatureInspection.infer>;
export type ExportSearch = ProtocolType<typeof inspectionSchemas.exportSearch.infer>;
export type PublicSubpathDiscovery = ProtocolType<
  typeof inspectionSchemas.publicSubpathDiscovery.infer
>;
export type InspectedModuleExportDeclarations = ProtocolType<
  typeof inspectionSchemas.inspectedModuleExportDeclarations.infer
>;
export type DeclarationInspection = ProtocolType<
  typeof inspectionSchemas.declarationInspection.infer
>;
export type MemberInspection = ProtocolType<typeof inspectionSchemas.memberInspection.infer>;
export type PublicInterfaceComparisonTarget = ProtocolType<
  typeof inspectionSchemas.comparisonTarget.infer
>;
export type PublicInterfaceComparison = ProtocolType<
  typeof inspectionSchemas.publicInterfaceComparison.infer
>;
export type AtomicInspectionResult =
  | InterfaceOverview
  | ExportInspection
  | SignatureInspection
  | ExportSearch
  | PublicSubpathDiscovery
  | DeclarationInspection
  | MemberInspection;
export interface InspectionPlan {
  readonly intent: "inspection-plan";
  readonly inspections: readonly AtomicInspectionResult[];
}
export type InspectionResult = AtomicInspectionResult | InspectionPlan | PublicInterfaceComparison;
export type InspectionFailure = ProtocolType<typeof inspectionSchemas.inspectionFailure.infer>;

/** A complete Inspection Result or an explicit non-authoritative failure. */
export type InspectionOutcome<Result extends InspectionResult = InspectionResult> =
  | {
      readonly status: "success";
      readonly result: Result;
    }
  | InspectionFailure;

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
    if (!isInspectionOutcome(value)) {
      return INVALID_RESULT_OUTCOME;
    }
    return value.status !== "success" || value.result.intent === intent
      ? value
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
  return (
    result.intent !== "inspection-plan" &&
    result.intent !== "public-interface-comparison" &&
    inspectionMatchesTarget(result, request.request) &&
    inspectionMatchesPlanQuery(result, simpleRequestPlanQuery(request))
  );
}

function simpleRequestPlanQuery(
  request: Exclude<
    AnalysisRequest,
    { readonly intent: "inspection-plan" | "declaration-inspection" | "member-inspection" }
  >,
): InspectionPlanQuery {
  switch (request.intent) {
    case "interface-overview":
      return { intent: request.intent };
    case "export-inspection":
      return { intent: request.intent, exportName: request.request.exportName };
    case "signature-inspection":
      return { intent: request.intent, exportName: request.request.exportName };
    case "export-search":
      return { intent: request.intent, query: request.request.query };
    case "public-subpath-discovery":
      return { intent: request.intent };
  }
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
    packageIdentitiesEqual(inspection.packageIdentity, expected.packageIdentity) &&
    packageIdentitiesEqual(inspection.declarationProvider, expected.declarationProvider)
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
      left.version === right.version)
  );
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

function isInspectionOutcome(value: unknown): value is InspectionOutcome {
  // Manual graph guards run before ArkType so cyclic, sparse, accessor-backed,
  // or excessively deep values cannot make recursive schema validation unsafe.
  if (!hasBoundedDataPropertyGraph(value) || !hasBoundedNamespaceGraph(value)) {
    return false;
  }
  return isInspectionPlanSuccess(value)
    ? isValidInspectionPlanSuccess(value)
    : inspectionOutcomeSchema.allows(value);
}

function isInspectionPlanSuccess(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["status"] === "success" &&
    isRecord(value["result"]) &&
    value["result"]["intent"] === "inspection-plan"
  );
}

function isValidInspectionPlanSuccess(value: unknown): value is InspectionOutcome<InspectionPlan> {
  const result = inspectionPlanResult(value);
  if (result === undefined) {
    return false;
  }
  const inspections = result["inspections"];
  return (
    Array.isArray(inspections) &&
    hasInspectionPlanLength(inspections) &&
    everyArrayItem(inspections, (inspection) => atomicInspectionResultSchema.allows(inspection))
  );
}

function inspectionPlanResult(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (
    !isRecord(value) ||
    value["status"] !== "success" ||
    !hasOnlyKeys(value, ["status", "result"])
  ) {
    return undefined;
  }
  const result = value["result"];
  return isRecord(result) &&
    result["intent"] === "inspection-plan" &&
    hasOnlyKeys(result, ["intent", "inspections"])
    ? result
    : undefined;
}

function hasInspectionPlanLength(inspections: readonly unknown[]): boolean {
  return inspections.length >= 1 && inspections.length <= 16;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function hasBoundedDataPropertyGraph(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<object>();

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const candidate = pending[cursor];
    if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);
    if (visited.size > MAX_PROTOCOL_GRAPH_OBJECTS) {
      return false;
    }

    if (!queueProtocolChildren(candidate, pending) || pending.length > MAX_PROTOCOL_GRAPH_VALUES) {
      return false;
    }
  }
  return true;
}

function queueProtocolChildren(candidate: object, pending: unknown[]): boolean {
  const keys = Object.keys(candidate);
  if (Array.isArray(candidate)) {
    return queueDenseArrayItems(candidate, keys, pending);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
    pending.push(descriptor.value);
  }
  return true;
}

function queueDenseArrayItems(
  values: readonly unknown[],
  keys: readonly string[],
  pending: unknown[],
): boolean {
  if (keys.length !== values.length) {
    return false;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || key !== String(index)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
    pending.push(descriptor.value);
  }
  return true;
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
